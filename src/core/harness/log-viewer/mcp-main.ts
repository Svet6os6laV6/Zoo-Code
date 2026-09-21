/**
 * stdio entrypoint for the harness logs MCP server.
 *
 * Started by the extension as `node <bundle>/harness-logs-mcp.js <logsDirectory>`
 * (registered in `mcp_settings.json` as `harness-logs`). The logs directory can
 * come from the first CLI argument or from `HARNESS_LOGS_DIR`.
 *
 * stdout carries the MCP protocol only, so every diagnostic goes to stderr.
 * The process is independent from the harness: a configuration mistake ends it
 * with a clear stderr message instead of corrupting the protocol stream.
 */

import * as path from "path"

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { createHarnessLogsMcpServer } from "./mcp-server"

export const HARNESS_LOGS_DIR_ENV = "HARNESS_LOGS_DIR"
/** Optional: session id of the running harness, flags it `active` in listings. */
export const HARNESS_LOGS_SESSION_ENV = "HARNESS_LOGS_SESSION_ID"

const LOG_PREFIX = "[harness-logs-mcp]"
const MISSING_DIRECTORY_MESSAGE = `missing logs directory: pass it as the first argument or set ${HARNESS_LOGS_DIR_ENV}`

function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value.length > 0 ? value : undefined
}

/** First CLI argument wins over the environment; `undefined` means "not configured". */
export function resolveLogsDirectory(
	argv: readonly string[],
	env: Record<string, string | undefined>,
): string | undefined {
	return nonEmpty(argv[0]) ?? nonEmpty(env[HARNESS_LOGS_DIR_ENV])
}

/** Optional second CLI argument wins over the environment. */
export function resolveActiveSessionId(
	argv: readonly string[],
	env: Record<string, string | undefined>,
): string | undefined {
	return nonEmpty(argv[1]) ?? nonEmpty(env[HARNESS_LOGS_SESSION_ENV])
}

/**
 * Starts the server on stdio and resolves with the process exit code. Missing
 * configuration is reported on stderr and never on stdout.
 */
export async function main(
	argv: readonly string[] = process.argv.slice(2),
	env: Record<string, string | undefined> = process.env,
): Promise<number> {
	const logsDirectory = resolveLogsDirectory(argv, env)

	if (logsDirectory === undefined) {
		process.stderr.write(`${LOG_PREFIX} ${MISSING_DIRECTORY_MESSAGE}\n`)
		return 1
	}

	const server = createHarnessLogsMcpServer({
		logsDirectory: path.resolve(logsDirectory),
		activeSessionId: resolveActiveSessionId(argv, env),
	})

	await server.connect(new StdioServerTransport())

	return 0
}

/**
 * True only when this bundled CommonJS entrypoint is the executed script
 * (`node dist/mcp/harness-logs-mcp.js`).
 *
 * `require`/`module` exist only in CommonJS, and the `typeof` guards keep the
 * comparison from evaluating them when the module is imported (Vitest). The
 * `VITEST` check is explicit: tests import this module for `resolveLogsDirectory`
 * and must never end up listening on stdin.
 */
function isScriptEntryPoint(): boolean {
	if (process.env.VITEST) {
		return false
	}

	return typeof require !== "undefined" && typeof module !== "undefined" && require.main === module
}

if (isScriptEntryPoint()) {
	void main()
		.then((exitCode) => {
			if (exitCode !== 0) {
				process.exitCode = exitCode
			}
		})
		.catch((error: unknown) => {
			process.stderr.write(`${LOG_PREFIX} ${error instanceof Error ? error.message : String(error)}\n`)
			process.exitCode = 1
		})
}
