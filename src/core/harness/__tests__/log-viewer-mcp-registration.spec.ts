import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	createHarnessLogsMcpServerEntry,
	McpSettingsParseError,
	registerHarnessLogsMcpServer,
} from "../log-viewer/mcp-registration"
import { HARNESS_LOGS_MCP_SERVER_NAME } from "../log-viewer/mcp-server"

const SCRIPT_PATH = "/extension/dist/mcp/harness-logs-mcp.js"
const LOGS_DIRECTORY = "/storage/harness-logs"

type Settings = { mcpServers?: Record<string, unknown> } & Record<string, unknown>

type Fixture = {
	directory: string
	settingsPath: string
	cleanup(): Promise<void>
}

let fixture: Fixture | undefined

async function setup(initialContent?: string): Promise<Fixture> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "harness-logs-registration-"))
	const settingsPath = path.join(directory, "mcp_settings.json")

	if (initialContent !== undefined) {
		await fs.writeFile(settingsPath, initialContent, "utf8")
	}

	fixture = {
		directory,
		settingsPath,
		async cleanup() {
			await fs.rm(directory, { recursive: true, force: true })
		},
	}

	return fixture
}

afterEach(async () => {
	await fixture?.cleanup()
	fixture = undefined
})

async function readRaw(settingsPath: string): Promise<string> {
	return fs.readFile(settingsPath, "utf8")
}

async function readSettings(settingsPath: string): Promise<Settings> {
	return JSON.parse(await readRaw(settingsPath)) as Settings
}

function register(options: { settingsPath: string }) {
	return registerHarnessLogsMcpServer({ ...options, scriptPath: SCRIPT_PATH, logsDirectory: LOGS_DIRECTORY })
}

describe("createHarnessLogsMcpServerEntry", () => {
	it("describes the stdio invocation the entrypoint expects", () => {
		expect(createHarnessLogsMcpServerEntry({ scriptPath: SCRIPT_PATH, logsDirectory: LOGS_DIRECTORY })).toEqual({
			type: "stdio",
			command: "node",
			args: [SCRIPT_PATH, LOGS_DIRECTORY],
		})
	})
})

describe("registerHarnessLogsMcpServer", () => {
	it("creates mcp_settings.json with the harness-logs entry when the file is missing", async () => {
		const { settingsPath } = await setup()

		expect(await register({ settingsPath })).toBe(true)

		expect(await readSettings(settingsPath)).toEqual({
			mcpServers: {
				[HARNESS_LOGS_MCP_SERVER_NAME]: {
					type: "stdio",
					command: "node",
					args: [SCRIPT_PATH, LOGS_DIRECTORY],
				},
			},
		})
	})

	it("keeps existing servers, their order and unrelated top-level keys", async () => {
		const { settingsPath } = await setup(
			JSON.stringify({
				mcpServers: {
					alpha: { type: "stdio", command: "alpha-bin" },
					beta: { type: "streamable-http", url: "http://localhost:1234" },
				},
				unrelatedKey: { keep: true },
			}),
		)

		expect(await register({ settingsPath })).toBe(true)

		const settings = await readSettings(settingsPath)

		expect(Object.keys(settings.mcpServers ?? {})).toEqual(["alpha", "beta", HARNESS_LOGS_MCP_SERVER_NAME])
		expect(settings.mcpServers?.["alpha"]).toEqual({ type: "stdio", command: "alpha-bin" })
		expect(settings.mcpServers?.["beta"]).toEqual({ type: "streamable-http", url: "http://localhost:1234" })
		expect(settings["unrelatedKey"]).toEqual({ keep: true })
	})

	it("is idempotent: a current entry is not rewritten", async () => {
		const { settingsPath } = await setup()

		expect(await register({ settingsPath })).toBe(true)

		const firstWrite = await readRaw(settingsPath)

		expect(await register({ settingsPath })).toBe(false)
		expect(await readRaw(settingsPath)).toBe(firstWrite)
	})

	it("leaves an entry that only adds extra keys (same args) untouched", async () => {
		const { settingsPath } = await setup(
			JSON.stringify({
				mcpServers: {
					[HARNESS_LOGS_MCP_SERVER_NAME]: {
						type: "stdio",
						command: "node",
						args: [SCRIPT_PATH, LOGS_DIRECTORY],
						disabled: true,
					},
				},
			}),
		)

		expect(await register({ settingsPath })).toBe(false)

		expect(await readSettings(settingsPath)).toEqual({
			mcpServers: {
				[HARNESS_LOGS_MCP_SERVER_NAME]: {
					type: "stdio",
					command: "node",
					args: [SCRIPT_PATH, LOGS_DIRECTORY],
					disabled: true,
				},
			},
		})
	})

	it("updates the entry when the logs directory changed", async () => {
		const { settingsPath } = await setup(
			JSON.stringify({
				mcpServers: {
					[HARNESS_LOGS_MCP_SERVER_NAME]: {
						type: "stdio",
						command: "node",
						args: [SCRIPT_PATH, "/old/logs"],
					},
					alpha: { type: "stdio", command: "alpha-bin" },
				},
			}),
		)

		expect(await register({ settingsPath })).toBe(true)

		const settings = await readSettings(settingsPath)

		expect(settings.mcpServers?.[HARNESS_LOGS_MCP_SERVER_NAME]).toEqual({
			type: "stdio",
			command: "node",
			args: [SCRIPT_PATH, LOGS_DIRECTORY],
		})
		expect(Object.keys(settings.mcpServers ?? {})).toEqual([HARNESS_LOGS_MCP_SERVER_NAME, "alpha"])
	})

	it("updates an entry whose argv does not match the stdio contract", async () => {
		const { settingsPath } = await setup(
			JSON.stringify({
				mcpServers: {
					[HARNESS_LOGS_MCP_SERVER_NAME]: {
						type: "stdio",
						command: "node",
						args: [SCRIPT_PATH, LOGS_DIRECTORY, "--extra"],
					},
				},
			}),
		)

		expect(await register({ settingsPath })).toBe(true)

		expect((await readSettings(settingsPath)).mcpServers?.[HARNESS_LOGS_MCP_SERVER_NAME]).toEqual({
			type: "stdio",
			command: "node",
			args: [SCRIPT_PATH, LOGS_DIRECTORY],
		})
	})

	it("rejects a malformed JSON file and leaves it byte-for-byte untouched", async () => {
		const { settingsPath } = await setup("{ not json")
		const before = await readRaw(settingsPath)

		await expect(register({ settingsPath })).rejects.toBeInstanceOf(McpSettingsParseError)

		expect(await readRaw(settingsPath)).toBe(before)
	})

	it("rejects a non-object document and leaves it byte-for-byte untouched", async () => {
		const { settingsPath } = await setup(JSON.stringify(["not", "an", "object"]))
		const before = await readRaw(settingsPath)

		await expect(register({ settingsPath })).rejects.toBeInstanceOf(McpSettingsParseError)

		expect(await readRaw(settingsPath)).toBe(before)
	})

	it("names the file in the parse error so the user can fix it", async () => {
		const { settingsPath } = await setup("null")

		await expect(register({ settingsPath })).rejects.toThrow(settingsPath)
	})

	// Boundary of the parse-error protection: only the document itself must be an
	// object. A non-object `mcpServers` value holds no servers to lose, so it is
	// replaced with a valid object rather than failing registration.
	it("replaces a non-object mcpServers value with a valid object", async () => {
		const { settingsPath } = await setup(JSON.stringify({ mcpServers: "not-an-object" }))

		expect(await register({ settingsPath })).toBe(true)

		expect((await readSettings(settingsPath)).mcpServers).toEqual({
			[HARNESS_LOGS_MCP_SERVER_NAME]: {
				type: "stdio",
				command: "node",
				args: [SCRIPT_PATH, LOGS_DIRECTORY],
			},
		})
	})
})
