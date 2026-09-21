/**
 * stdio MCP server exposing the harness JSONL log sessions as tools.
 *
 * The server is a separate process started by the extension (registered in
 * `mcp_settings.json` as `harness-logs`). It only *reads*
 * `<logsDirectory>/<sessionId>.jsonl` (plus rotations) through `sessions.ts`,
 * so it never touches the harness logger, its sinks, or the log viewer server.
 *
 * Tool failures are reported as MCP tool errors (`isError`), never as a crashed
 * server: a broken session id or an unreadable file must not take the harness
 * down, because the harness does not own this process.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"

import { HARNESS_LOG_LEVELS } from "@roo-code/core"

import {
	DEFAULT_SESSION_RECORDS_LIMIT,
	MAX_SESSION_RECORDS_LIMIT,
	isValidSessionId,
	listSessions,
	readSessionRecords,
} from "./sessions"

export const HARNESS_LOGS_MCP_SERVER_NAME = "harness-logs"
export const HARNESS_LOGS_MCP_SERVER_VERSION = "1.0.0"

/**
 * Tool names are a stable contract: the extension registration (T05) and the
 * model both address the server by these names.
 */
export const HARNESS_LOG_TOOL_NAMES = {
	listSessions: "harness_logs_list_sessions",
	readRecords: "harness_logs_read_records",
	searchRecords: "harness_logs_search_records",
	sessionSummary: "harness_logs_session_summary",
} as const

export const SEARCH_RECORDS_DEFAULT_LIMIT = 100
export const SEARCH_RECORDS_MAX_LIMIT = 1_000

export type HarnessLogsMcpServerOptions = {
	/** Directory with `<sessionId>.jsonl` files and their rotations. */
	readonly logsDirectory: string
	/** Session id of the current harness run; flagged `active` in the session list. */
	readonly activeSessionId?: string
}

/** Mirrors `HarnessLogRecordKind`; the type union has no runtime constant. */
const RECORD_KIND_SCHEMA = z.enum(["event", "span", "decision", "mutation"])

type LogRecordFields = Record<string, unknown>

function isRecordFields(value: unknown): value is LogRecordFields {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function contextFields(record: LogRecordFields): LogRecordFields {
	const context = record["context"]

	return isRecordFields(context) ? context : {}
}

function textField(source: LogRecordFields, key: string): string | null {
	const value = source[key]

	return typeof value === "string" ? value : null
}

function hasFilterValue(value: string | undefined): value is string {
	return value !== undefined && value.length > 0
}

type RecordFilter = {
	readonly query?: string
	readonly level?: string
	readonly kind?: string
	readonly taskId?: string
	readonly txxId?: string
	readonly mode?: string
}

function matchesFilter(record: unknown, filter: RecordFilter): boolean {
	if (!isRecordFields(record)) {
		return false
	}

	if (hasFilterValue(filter.level) && textField(record, "level") !== filter.level) {
		return false
	}

	if (hasFilterValue(filter.kind) && textField(record, "kind") !== filter.kind) {
		return false
	}

	const context = contextFields(record)

	if (hasFilterValue(filter.taskId) && textField(context, "taskId") !== filter.taskId) {
		return false
	}

	if (hasFilterValue(filter.txxId) && textField(context, "txxId") !== filter.txxId) {
		return false
	}

	if (hasFilterValue(filter.mode) && textField(context, "mode") !== filter.mode) {
		return false
	}

	if (hasFilterValue(filter.query) && !containsText(record, filter.query)) {
		return false
	}

	return true
}

/** Case-insensitive substring match over the serialized record payload. */
function containsText(record: LogRecordFields, query: string): boolean {
	const needle = query.toLowerCase()

	try {
		return JSON.stringify(record).toLowerCase().includes(needle)
	} catch {
		// A payload that cannot be serialized (cycle) simply does not match.
		return false
	}
}

/**
 * Reads every record of one session, rotations included, oldest first.
 *
 * `readSessionRecords` bounds a single page, so pages are chained here; the
 * session budget stays `MAX_SESSION_RECORDS_LIMIT`, mirroring the reader.
 * Record indices are preserved exactly as `read_records` reports them, so a
 * search hit can be followed up with `read_records` + `after`.
 */
async function readAllSessionRecords(logsDirectory: string, sessionId: string): Promise<unknown[]> {
	const records: unknown[] = []
	let after = 0

	while (records.length < MAX_SESSION_RECORDS_LIMIT) {
		const page = await readSessionRecords(logsDirectory, sessionId, { after, limit: MAX_SESSION_RECORDS_LIMIT })

		if (page === undefined) {
			break
		}

		records.push(...page.records)

		if (page.nextAfter === null) {
			break
		}

		after = page.nextAfter
	}

	return records.slice(0, MAX_SESSION_RECORDS_LIMIT)
}

type SearchMatch = {
	readonly sessionId: string
	/** Index of the record inside the session, as reported by `read_records`. */
	readonly index: number
	readonly record: unknown
}

type SearchResult = {
	readonly records: SearchMatch[]
	/** True when more records matched than `limit` allowed to return. */
	readonly truncated: boolean
	/** Sessions consulted in scan order (newest first when unfiltered); stops once truncated. */
	readonly sessionsSearched: string[]
}

async function searchRecords(
	logsDirectory: string,
	activeSessionId: string,
	filter: RecordFilter,
	sessionId: string | undefined,
	limit: number,
): Promise<SearchResult> {
	const sessionIds =
		sessionId === undefined
			? (await listSessions(logsDirectory, activeSessionId)).map((session) => session.id)
			: [sessionId]

	const records: SearchMatch[] = []
	let truncated = false
	let scanned = 0

	for (const id of sessionIds) {
		scanned += 1

		const sessionRecords = await readAllSessionRecords(logsDirectory, id)

		for (let index = 0; index < sessionRecords.length; index += 1) {
			if (!matchesFilter(sessionRecords[index], filter)) {
				continue
			}

			if (records.length === limit) {
				truncated = true
				break
			}

			records.push({ sessionId: id, index, record: sessionRecords[index] })
		}

		if (truncated) {
			break
		}
	}

	return { records, truncated, sessionsSearched: sessionIds.slice(0, scanned) }
}

type SessionSummary = {
	readonly sessionId: string
	readonly recordCount: number
	readonly firstTimestamp: string | null
	readonly lastTimestamp: string | null
	readonly byLevel: Record<string, number>
	readonly byKind: Record<string, number>
	readonly taskIds: string[]
	readonly txxIds: string[]
	readonly modes: string[]
}

function summarizeSession(sessionId: string, records: readonly unknown[]): SessionSummary {
	const byLevel = new Map<string, number>()
	const byKind = new Map<string, number>()
	const taskIds = new Set<string>()
	const txxIds = new Set<string>()
	const modes = new Set<string>()
	let firstTimestamp: string | null = null
	let lastTimestamp: string | null = null

	for (const record of records) {
		if (!isRecordFields(record)) {
			continue
		}

		countValue(byLevel, textField(record, "level"))
		countValue(byKind, textField(record, "kind"))

		const context = contextFields(record)

		addValue(taskIds, textField(context, "taskId"))
		addValue(txxIds, textField(context, "txxId"))
		addValue(modes, textField(context, "mode"))

		const timestamp = textField(record, "timestamp")

		if (timestamp !== null) {
			if (firstTimestamp === null || timestamp < firstTimestamp) {
				firstTimestamp = timestamp
			}

			if (lastTimestamp === null || timestamp > lastTimestamp) {
				lastTimestamp = timestamp
			}
		}
	}

	return {
		sessionId,
		recordCount: records.length,
		firstTimestamp,
		lastTimestamp,
		byLevel: sortedCounts(byLevel),
		byKind: sortedCounts(byKind),
		taskIds: [...taskIds].sort(),
		txxIds: [...txxIds].sort(),
		modes: [...modes].sort(),
	}
}

function countValue(counts: Map<string, number>, key: string | null): void {
	if (key === null) {
		return
	}

	counts.set(key, (counts.get(key) ?? 0) + 1)
}

function addValue(target: Set<string>, value: string | null): void {
	if (value !== null && value.length > 0) {
		target.add(value)
	}
}

/** Sorted keys keep the summary stable across runs and easy to diff. */
function sortedCounts(counts: Map<string, number>): Record<string, number> {
	const sorted: Record<string, number> = {}

	for (const key of [...counts.keys()].sort()) {
		sorted[key] = counts.get(key) ?? 0
	}

	return sorted
}

function jsonResult(value: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }
}

function errorResult(message: string): CallToolResult {
	return { content: [{ type: "text", text: message }], isError: true }
}

function unknownSession(sessionId: string): CallToolResult {
	return errorResult(`unknown session: ${sessionId}`)
}

/** Tool failures become MCP tool errors; the server process stays alive. */
async function runTool(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await run()
	} catch (error) {
		return errorResult(error instanceof Error ? error.message : String(error))
	}
}

/**
 * Creates the harness logs MCP server. The caller owns the transport: the
 * extension entrypoint connects `StdioServerTransport`, tests connect an
 * `InMemoryTransport` pair.
 */
export function createHarnessLogsMcpServer(options: HarnessLogsMcpServerOptions): McpServer {
	const server = new McpServer({
		name: HARNESS_LOGS_MCP_SERVER_NAME,
		version: HARNESS_LOGS_MCP_SERVER_VERSION,
	})

	const activeSessionId = options.activeSessionId ?? ""

	server.registerTool(
		HARNESS_LOG_TOOL_NAMES.listSessions,
		{
			title: "List harness log sessions",
			description:
				"List the harness JSONL log sessions available on disk, newest first. " +
				"Use a returned session id with the other harness_logs_* tools.",
			annotations: { readOnlyHint: true },
		},
		() => runTool(async () => jsonResult({ sessions: await listSessions(options.logsDirectory, activeSessionId) })),
	)

	server.registerTool(
		HARNESS_LOG_TOOL_NAMES.readRecords,
		{
			title: "Read harness log records",
			description:
				"Read records of one harness log session in chronological order (rotations included). " +
				"Page with `after` = the returned `nextAfter`.",
			inputSchema: {
				sessionId: z.string().describe("Session id from harness_logs_list_sessions."),
				after: z.number().int().min(0).optional().describe("Record index to start from; defaults to 0."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(MAX_SESSION_RECORDS_LIMIT)
					.optional()
					.describe(`Maximum records to return; defaults to ${DEFAULT_SESSION_RECORDS_LIMIT}.`),
			},
			annotations: { readOnlyHint: true },
		},
		({ sessionId, after, limit }) =>
			runTool(async () => {
				if (!isValidSessionId(sessionId)) {
					return unknownSession(sessionId)
				}

				const page = await readSessionRecords(options.logsDirectory, sessionId, { after, limit })

				if (page === undefined) {
					return unknownSession(sessionId)
				}

				return jsonResult({ records: page.records, nextAfter: page.nextAfter })
			}),
	)

	server.registerTool(
		HARNESS_LOG_TOOL_NAMES.searchRecords,
		{
			title: "Search harness log records",
			description:
				"Search harness log records by free text and/or structured fields. " +
				"Without `sessionId` every session is searched, newest first. " +
				"Each hit reports its `sessionId` and record `index` (usable as `after` in harness_logs_read_records).",
			inputSchema: {
				sessionId: z
					.string()
					.optional()
					.describe("Restrict the search to one session; omitted searches all sessions."),
				query: z
					.string()
					.optional()
					.describe("Case-insensitive substring match over the serialized record payload."),
				level: z.enum(HARNESS_LOG_LEVELS).optional().describe("Exact log level match."),
				kind: RECORD_KIND_SCHEMA.optional().describe("Exact record kind match."),
				taskId: z.string().optional().describe("Exact harness task id match (context.taskId)."),
				txxId: z.string().optional().describe("Exact implementation unit match (context.txxId)."),
				mode: z.string().optional().describe("Exact mode slug match (context.mode)."),
				limit: z
					.number()
					.int()
					.min(1)
					.max(SEARCH_RECORDS_MAX_LIMIT)
					.optional()
					.describe(`Maximum matches to return; defaults to ${SEARCH_RECORDS_DEFAULT_LIMIT}.`),
			},
			annotations: { readOnlyHint: true },
		},
		({ sessionId, query, level, kind, taskId, txxId, mode, limit }) =>
			runTool(async () => {
				if (sessionId !== undefined && !isValidSessionId(sessionId)) {
					return unknownSession(sessionId)
				}

				const result = await searchRecords(
					options.logsDirectory,
					activeSessionId,
					{ query, level, kind, taskId, txxId, mode },
					sessionId,
					limit ?? SEARCH_RECORDS_DEFAULT_LIMIT,
				)

				return jsonResult(result)
			}),
	)

	server.registerTool(
		HARNESS_LOG_TOOL_NAMES.sessionSummary,
		{
			title: "Summarize a harness log session",
			description:
				"Summarize one harness log session: record count, time range, counts by level and kind, " +
				"and the task/txx/mode values seen in the records.",
			inputSchema: {
				sessionId: z.string().describe("Session id from harness_logs_list_sessions."),
			},
			annotations: { readOnlyHint: true },
		},
		({ sessionId }) =>
			runTool(async () => {
				if (!isValidSessionId(sessionId)) {
					return unknownSession(sessionId)
				}

				const records = await readAllSessionRecords(options.logsDirectory, sessionId)

				return jsonResult(summarizeSession(sessionId, records))
			}),
	)

	return server
}
