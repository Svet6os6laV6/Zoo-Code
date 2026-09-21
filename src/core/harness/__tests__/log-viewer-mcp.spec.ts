import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { HarnessLogRecord } from "@roo-code/core"

import {
	HARNESS_LOGS_DIR_ENV,
	HARNESS_LOGS_SESSION_ENV,
	main,
	resolveActiveSessionId,
	resolveLogsDirectory,
} from "../log-viewer/mcp-main"
import { HARNESS_LOG_TOOL_NAMES, createHarnessLogsMcpServer } from "../log-viewer/mcp-server"

const MTIME_OLD = new Date("2024-01-01T00:00:00.000Z")
const MTIME_MID = new Date("2024-02-01T00:00:00.000Z")
const MTIME_NEW = new Date("2024-03-01T00:00:00.000Z")

const T0 = "2024-01-01T10:00:00.000Z"
const T1 = "2024-01-01T10:00:01.000Z"
const T2 = "2024-01-01T10:00:02.000Z"

type RecordOptions = {
	name: string
	level?: HarnessLogRecord["level"]
	kind?: HarnessLogRecord["kind"]
	taskId?: string | null
	txxId?: string | null
	mode?: string | null
	timestamp?: string
	reason?: string
}

function makeRecord(options: RecordOptions): HarnessLogRecord {
	return {
		kind: options.kind ?? "event",
		name: options.name,
		level: options.level ?? "info",
		timestamp: options.timestamp ?? T0,
		context: {
			traceId: "trace-1",
			spanId: null,
			sessionId: "test-session",
			taskId: options.taskId ?? null,
			agentTaskId: null,
			txxId: options.txxId ?? null,
			mode: options.mode ?? null,
		},
		...(options.reason === undefined ? {} : { reason: options.reason }),
	}
}

async function writeSession(
	logsDirectory: string,
	fileName: string,
	records: HarnessLogRecord[],
	modifiedAt?: Date,
): Promise<void> {
	const filePath = path.join(logsDirectory, fileName)

	await fs.writeFile(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8")

	if (modifiedAt) {
		await fs.utimes(filePath, modifiedAt, modifiedAt)
	}
}

type Fixture = {
	logsDirectory: string
	client: Client
	cleanup(): Promise<void>
}

let fixture: Fixture | undefined

async function startFixture(activeSessionId?: string): Promise<Fixture> {
	const logsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "harness-logs-mcp-"))
	const server = createHarnessLogsMcpServer({ logsDirectory, activeSessionId })
	const client = new Client({ name: "harness-logs-mcp-test", version: "1.0.0" })

	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

	await server.connect(serverTransport)
	await client.connect(clientTransport)

	fixture = {
		logsDirectory,
		client,
		cleanup: async () => {
			await client.close()
			await server.close()
			await fs.rm(logsDirectory, { recursive: true, force: true })
		},
	}

	return fixture
}

afterEach(async () => {
	await fixture?.cleanup()
	fixture = undefined
	vi.restoreAllMocks()
})

/** Narrow view of the MCP tool result used by these assertions. */
type ToolResponse = {
	readonly content: ReadonlyArray<{ type: string; text?: string }>
	readonly isError: boolean
}

function textOf(result: ToolResponse): string {
	const block = result.content.find((item) => item.type === "text")

	if (block === undefined || typeof block.text !== "string") {
		throw new Error("tool result did not contain text content")
	}

	return block.text
}

function jsonOf(result: ToolResponse): unknown {
	return JSON.parse(textOf(result))
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResponse> {
	if (fixture === undefined) {
		throw new Error("fixture is not started")
	}

	const result = await fixture.client.callTool({ name, arguments: args })
	const content = result.content

	// Task-based tool results carry `toolResult` instead of `content`; every tool
	// here answers synchronously, so only `content` is expected.
	if (!Array.isArray(content)) {
		throw new Error(`tool ${name} returned an unexpected result shape`)
	}

	return { content, isError: result.isError === true }
}

type SessionsPayload = {
	sessions: Array<{ id: string; fileName: string; sizeBytes: number; modifiedAt: string; active: boolean }>
}

type ReadPayload = {
	records: Array<{ name: string }>
	nextAfter: number | null
}

type SearchPayload = {
	records: Array<{ sessionId: string; index: number; record: { name: string } }>
	truncated: boolean
	sessionsSearched: string[]
}

type SummaryPayload = {
	sessionId: string
	recordCount: number
	firstTimestamp: string | null
	lastTimestamp: string | null
	byLevel: Record<string, number>
	byKind: Record<string, number>
	taskIds: string[]
	txxIds: string[]
	modes: string[]
}

/** session-old: a0 (info/event), a1 (warn/decision), a2 (error/span); session-new: b0 (error/event). */
async function writeSearchFixture(logsDirectory: string): Promise<void> {
	await writeSession(
		logsDirectory,
		"session-old.jsonl",
		[
			makeRecord({
				name: "scheduler.assign-next",
				taskId: "TASK-1",
				txxId: "T04",
				mode: "code",
				timestamp: T0,
				reason: "assigned T04",
			}),
			makeRecord({
				name: "artifact-validator.validate",
				kind: "decision",
				level: "warn",
				taskId: "TASK-1",
				txxId: "T05",
				mode: "architect",
				timestamp: T1,
			}),
			makeRecord({
				name: "mode-runner.run",
				kind: "span",
				level: "error",
				taskId: "TASK-2",
				mode: "code",
				timestamp: T2,
			}),
		],
		MTIME_OLD,
	)

	await writeSession(
		logsDirectory,
		"session-new.jsonl",
		[
			makeRecord({
				name: "scheduler.assign-next-failed",
				level: "error",
				taskId: "TASK-1",
				txxId: "T04",
				mode: "code",
				timestamp: T0,
			}),
		],
		MTIME_NEW,
	)
}

describe("harness logs MCP server", () => {
	it("registers the four harness log tools", async () => {
		await startFixture()

		const tools = await fixture!.client.listTools()

		expect(tools.tools.map((tool) => tool.name).sort()).toEqual(
			[
				HARNESS_LOG_TOOL_NAMES.listSessions,
				HARNESS_LOG_TOOL_NAMES.readRecords,
				HARNESS_LOG_TOOL_NAMES.searchRecords,
				HARNESS_LOG_TOOL_NAMES.sessionSummary,
			].sort(),
		)
	})

	it("lists sessions newest first, flags the active one, and ignores rotations", async () => {
		await startFixture("active-session")

		await writeSession(fixture!.logsDirectory, "session-old.jsonl", [makeRecord({ name: "old" })], MTIME_OLD)
		await writeSession(fixture!.logsDirectory, "session-new.jsonl", [makeRecord({ name: "new" })], MTIME_MID)
		await writeSession(fixture!.logsDirectory, "session-new.jsonl.1", [makeRecord({ name: "rotated" })], MTIME_OLD)
		await writeSession(fixture!.logsDirectory, "active-session.jsonl", [makeRecord({ name: "live" })], MTIME_NEW)
		await fs.writeFile(path.join(fixture!.logsDirectory, "notes.txt"), "not a session\n", "utf8")
		await fs.writeFile(path.join(fixture!.logsDirectory, "bad name.jsonl"), "\n", "utf8")

		const payload = jsonOf(await callTool(HARNESS_LOG_TOOL_NAMES.listSessions)) as SessionsPayload

		expect(payload.sessions.map((session) => session.id)).toEqual(["active-session", "session-new", "session-old"])
		expect(payload.sessions.map((session) => session.active)).toEqual([true, false, false])
		expect(payload.sessions[0]).toMatchObject({
			fileName: "active-session.jsonl",
			modifiedAt: MTIME_NEW.toISOString(),
		})
		expect(payload.sessions[1].modifiedAt).toBe(MTIME_MID.toISOString())
		expect(payload.sessions[0].sizeBytes).toBeGreaterThan(0)
	})

	it("returns an empty session list when the logs directory is missing", async () => {
		await startFixture()
		await fs.rm(fixture!.logsDirectory, { recursive: true, force: true })

		const payload = jsonOf(await callTool(HARNESS_LOG_TOOL_NAMES.listSessions)) as SessionsPayload

		expect(payload.sessions).toEqual([])
	})

	it("reads records across rotations with stable pagination and a corrupted tail", async () => {
		await startFixture()

		await writeSession(fixture!.logsDirectory, "session-a.jsonl.1", [
			makeRecord({ name: "r0" }),
			makeRecord({ name: "r1" }),
		])
		await writeSession(fixture!.logsDirectory, "session-a.jsonl", [
			makeRecord({ name: "r2" }),
			makeRecord({ name: "r3" }),
		])

		// A truncated tail line must not consume a record index.
		await fs.appendFile(path.join(fixture!.logsDirectory, "session-a.jsonl"), '{"kind":"event"', "utf8")

		const all = jsonOf(
			await callTool(HARNESS_LOG_TOOL_NAMES.readRecords, { sessionId: "session-a" }),
		) as ReadPayload

		expect(all.records.map((record) => record.name)).toEqual(["r0", "r1", "r2", "r3"])
		expect(all.nextAfter).toBeNull()

		const firstPage = jsonOf(
			await callTool(HARNESS_LOG_TOOL_NAMES.readRecords, { sessionId: "session-a", after: 0, limit: 2 }),
		) as ReadPayload

		expect(firstPage.records.map((record) => record.name)).toEqual(["r0", "r1"])
		expect(firstPage.nextAfter).toBe(2)

		const secondPage = jsonOf(
			await callTool(HARNESS_LOG_TOOL_NAMES.readRecords, {
				sessionId: "session-a",
				after: firstPage.nextAfter,
				limit: 2,
			}),
		) as ReadPayload

		expect(secondPage.records.map((record) => record.name)).toEqual(["r2", "r3"])
		expect(secondPage.nextAfter).toBeNull()
	})

	it("reports an unknown session instead of failing the server", async () => {
		await startFixture()

		const read = await callTool(HARNESS_LOG_TOOL_NAMES.readRecords, { sessionId: "../escape" })
		const summary = await callTool(HARNESS_LOG_TOOL_NAMES.sessionSummary, { sessionId: "nested/session" })
		const search = await callTool(HARNESS_LOG_TOOL_NAMES.searchRecords, { sessionId: "..", query: "x" })

		for (const result of [read, summary, search]) {
			expect(result.isError).toBe(true)
			expect(textOf(result)).toMatch(/unknown session/i)
		}
	})

	it("searches all sessions newest first and reports sessionId with the record index", async () => {
		await startFixture()
		await writeSearchFixture(fixture!.logsDirectory)

		const payload = jsonOf(await callTool(HARNESS_LOG_TOOL_NAMES.searchRecords)) as SearchPayload

		expect(payload.truncated).toBe(false)
		expect(payload.sessionsSearched).toEqual(["session-new", "session-old"])
		expect(payload.records.map((match) => [match.sessionId, match.index, match.record.name])).toEqual([
			["session-new", 0, "scheduler.assign-next-failed"],
			["session-old", 0, "scheduler.assign-next"],
			["session-old", 1, "artifact-validator.validate"],
			["session-old", 2, "mode-runner.run"],
		])
	})

	it("filters search results by query, level, kind, taskId, txxId and mode", async () => {
		await startFixture()
		await writeSearchFixture(fixture!.logsDirectory)

		const names = async (args: Record<string, unknown>): Promise<string[]> => {
			const payload = jsonOf(await callTool(HARNESS_LOG_TOOL_NAMES.searchRecords, args)) as SearchPayload

			return payload.records.map((match) => match.record.name)
		}

		expect(await names({ query: "assign" })).toEqual(["scheduler.assign-next-failed", "scheduler.assign-next"])
		expect(await names({ level: "error" })).toEqual(["scheduler.assign-next-failed", "mode-runner.run"])
		expect(await names({ kind: "decision" })).toEqual(["artifact-validator.validate"])
		expect(await names({ taskId: "TASK-1", txxId: "T04" })).toEqual([
			"scheduler.assign-next-failed",
			"scheduler.assign-next",
		])
		expect(await names({ mode: "architect" })).toEqual(["artifact-validator.validate"])
		// An empty free-text filter is treated as absent instead of matching nothing.
		expect(await names({ sessionId: "session-old", query: "" })).toEqual([
			"scheduler.assign-next",
			"artifact-validator.validate",
			"mode-runner.run",
		])

		const scoped = jsonOf(
			await callTool(HARNESS_LOG_TOOL_NAMES.searchRecords, { sessionId: "session-old", query: "assigned T04" }),
		) as SearchPayload

		expect(scoped.records.map((match) => [match.index, match.record.name])).toEqual([[0, "scheduler.assign-next"]])
		expect(scoped.sessionsSearched).toEqual(["session-old"])
	})

	it("truncates search results at the limit and stops scanning sessions", async () => {
		await startFixture()
		await writeSearchFixture(fixture!.logsDirectory)

		const payload = jsonOf(await callTool(HARNESS_LOG_TOOL_NAMES.searchRecords, { limit: 1 })) as SearchPayload

		expect(payload.records.map((match) => match.record.name)).toEqual(["scheduler.assign-next-failed"])
		expect(payload.truncated).toBe(true)
		// Scanning stopped as soon as the extra match proved the result was cut off.
		expect(payload.sessionsSearched).toEqual(["session-new", "session-old"])
	})

	it("summarizes a session with counts, time range and correlation values", async () => {
		await startFixture()
		await writeSearchFixture(fixture!.logsDirectory)

		const payload = jsonOf(
			await callTool(HARNESS_LOG_TOOL_NAMES.sessionSummary, { sessionId: "session-old" }),
		) as SummaryPayload

		expect(payload).toEqual({
			sessionId: "session-old",
			recordCount: 3,
			firstTimestamp: T0,
			lastTimestamp: T2,
			byLevel: { error: 1, info: 1, warn: 1 },
			byKind: { decision: 1, event: 1, span: 1 },
			taskIds: ["TASK-1", "TASK-2"],
			txxIds: ["T04", "T05"],
			modes: ["architect", "code"],
		})
	})
})

describe("harness logs MCP entrypoint", () => {
	it("resolves the logs directory from the first argument, then the environment", () => {
		expect(resolveLogsDirectory(["/logs", "session"], {})).toBe("/logs")
		expect(resolveLogsDirectory(["/logs"], { [HARNESS_LOGS_DIR_ENV]: "/env-logs" })).toBe("/logs")
		expect(resolveLogsDirectory([], { [HARNESS_LOGS_DIR_ENV]: "/env-logs" })).toBe("/env-logs")
		expect(resolveLogsDirectory([""], { [HARNESS_LOGS_DIR_ENV]: "" })).toBeUndefined()
		expect(resolveLogsDirectory([], {})).toBeUndefined()
	})

	it("resolves the optional active session id from the second argument, then the environment", () => {
		expect(resolveActiveSessionId(["/logs", "session-arg"], { [HARNESS_LOGS_SESSION_ENV]: "session-env" })).toBe(
			"session-arg",
		)
		expect(resolveActiveSessionId(["/logs"], { [HARNESS_LOGS_SESSION_ENV]: "session-env" })).toBe("session-env")
		expect(resolveActiveSessionId(["/logs"], {})).toBeUndefined()
	})

	it("exits with a stderr diagnostic when no logs directory is configured", async () => {
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)

		await expect(main([], {})).resolves.toBe(1)

		expect(stderr).toHaveBeenCalledWith(expect.stringContaining(HARNESS_LOGS_DIR_ENV))
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("missing logs directory"))
	})
})
