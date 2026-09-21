/**
 * Registration of the harness logs MCP server (T04) in `mcp_settings.json`.
 *
 * The settings file does not belong to the harness: `McpHub` reads it, the
 * marketplace installer and the settings webview write it. Registration
 * therefore touches exactly one entry (`harness-logs`) and keeps every other
 * server, every other top-level key, and the server order intact.
 *
 * A missing or unparsable file is treated as an empty configuration instead of
 * an error: registration runs during extension activation, where a user-owned
 * file must never be able to break startup. The write itself goes through
 * `safeWriteJson` for atomicity and cross-process locking.
 */

import * as fs from "fs/promises"

import { safeWriteJson } from "../../../utils/safeWriteJson"
import { HARNESS_LOGS_MCP_SERVER_NAME } from "./mcp-server"

/** stdio server config as understood by `McpHub`. */
export type HarnessLogsMcpServerEntry = {
	readonly type: "stdio"
	readonly command: "node"
	/** `<scriptPath> <logsDirectory>`, read by the entrypoint's `main()`. */
	readonly args: readonly [string, string]
}

export type HarnessLogsMcpRegistrationOptions = {
	/** Absolute path to `mcp_settings.json`. */
	readonly settingsPath: string
	/** Absolute path to the bundled stdio entrypoint (`dist/mcp/harness-logs-mcp.js`). */
	readonly scriptPath: string
	/** Directory holding the harness JSONL sessions. */
	readonly logsDirectory: string
}

/**
 * The persisted shape of the registration. Exported so callers and tests share
 * one definition instead of duplicating the argv contract from T04.
 */
export function createHarnessLogsMcpServerEntry(
	options: Pick<HarnessLogsMcpRegistrationOptions, "scriptPath" | "logsDirectory">,
): HarnessLogsMcpServerEntry {
	return {
		type: "stdio",
		command: "node",
		args: [options.scriptPath, options.logsDirectory],
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Missing file, unparsable JSON and non-object documents all mean "no servers". */
async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
	let content: string

	try {
		content = await fs.readFile(settingsPath, "utf8")
	} catch {
		return {}
	}

	let parsed: unknown

	try {
		parsed = JSON.parse(content)
	} catch {
		return {}
	}

	return isPlainObject(parsed) ? parsed : {}
}

function readServers(settings: Record<string, unknown>): Record<string, unknown> {
	const servers = settings["mcpServers"]

	return isPlainObject(servers) ? servers : {}
}

/** An entry is current when it is the exact stdio config this module persists. */
function isCurrentEntry(existing: unknown, entry: HarnessLogsMcpServerEntry): boolean {
	if (!isPlainObject(existing)) {
		return false
	}

	const args = existing["args"]

	return (
		existing["type"] === entry.type &&
		existing["command"] === entry.command &&
		Array.isArray(args) &&
		args.length === entry.args.length &&
		args.every((value, index) => value === entry.args[index])
	)
}

/**
 * Adds or updates the `harness-logs` entry. Returns `true` when the settings
 * file was rewritten: an already current entry is left untouched, so repeated
 * calls are idempotent and do not churn the file (or the MCP hub's watcher).
 *
 * Errors (unreadable directory, failed write) propagate to the caller, which
 * decides whether they are fatal. Activation must treat them as non-fatal.
 */
export async function registerHarnessLogsMcpServer(options: HarnessLogsMcpRegistrationOptions): Promise<boolean> {
	const settings = await readSettings(options.settingsPath)
	const servers = readServers(settings)
	const entry = createHarnessLogsMcpServerEntry(options)

	if (isCurrentEntry(servers[HARNESS_LOGS_MCP_SERVER_NAME], entry)) {
		return false
	}

	// Assigning to an existing key keeps its position, so updating our own entry
	// never reorders the user's servers.
	servers[HARNESS_LOGS_MCP_SERVER_NAME] = entry
	settings["mcpServers"] = servers

	await safeWriteJson(options.settingsPath, settings, { prettyPrint: true })

	return true
}

/**
 * Removes only the `harness-logs` entry. Returns `true` when the settings file
 * was rewritten. Missing files, unparsable files and files without the entry
 * are left as they are.
 */
export async function unregisterHarnessLogsMcpServer(options: { settingsPath: string }): Promise<boolean> {
	const settings = await readSettings(options.settingsPath)
	const servers = readServers(settings)

	if (!Object.prototype.hasOwnProperty.call(servers, HARNESS_LOGS_MCP_SERVER_NAME)) {
		return false
	}

	delete servers[HARNESS_LOGS_MCP_SERVER_NAME]
	settings["mcpServers"] = servers

	await safeWriteJson(options.settingsPath, settings, { prettyPrint: true })

	return true
}
