import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import {
	createHarnessLogsMcpServerEntry,
	registerHarnessLogsMcpServer,
	unregisterHarnessLogsMcpServer,
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

	it("treats a broken JSON file as empty instead of failing", async () => {
		const { settingsPath } = await setup("{ not json")

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

	it("treats a non-object document (and a non-object mcpServers) as empty", async () => {
		const { settingsPath } = await setup(JSON.stringify(["not", "an", "object"]))

		expect(await register({ settingsPath })).toBe(true)
		expect(Object.keys((await readSettings(settingsPath)).mcpServers ?? {})).toEqual([HARNESS_LOGS_MCP_SERVER_NAME])

		const second = await setup(JSON.stringify({ mcpServers: "not-an-object" }))

		expect(await register({ settingsPath: second.settingsPath })).toBe(true)
		expect((await readSettings(second.settingsPath)).mcpServers).toEqual({
			[HARNESS_LOGS_MCP_SERVER_NAME]: {
				type: "stdio",
				command: "node",
				args: [SCRIPT_PATH, LOGS_DIRECTORY],
			},
		})
	})
})

describe("unregisterHarnessLogsMcpServer", () => {
	it("removes only the harness-logs entry and keeps the others", async () => {
		const { settingsPath } = await setup(
			JSON.stringify({
				mcpServers: {
					alpha: { type: "stdio", command: "alpha-bin" },
					[HARNESS_LOGS_MCP_SERVER_NAME]: {
						type: "stdio",
						command: "node",
						args: [SCRIPT_PATH, LOGS_DIRECTORY],
					},
					beta: { type: "streamable-http", url: "http://localhost:1234" },
				},
				unrelatedKey: "keep",
			}),
		)

		expect(await unregisterHarnessLogsMcpServer({ settingsPath })).toBe(true)

		const settings = await readSettings(settingsPath)

		expect(settings.mcpServers).toEqual({
			alpha: { type: "stdio", command: "alpha-bin" },
			beta: { type: "streamable-http", url: "http://localhost:1234" },
		})
		expect(settings["unrelatedKey"]).toBe("keep")
	})

	it("is a no-op when the entry or the file is absent", async () => {
		const { settingsPath } = await setup()
		const raw = async () => readRaw(settingsPath).catch(() => undefined)

		expect(await unregisterHarnessLogsMcpServer({ settingsPath })).toBe(false)

		const withOthers = await setup(JSON.stringify({ mcpServers: { alpha: { type: "stdio", command: "a" } } }))
		const before = await readRaw(withOthers.settingsPath)

		expect(await unregisterHarnessLogsMcpServer({ settingsPath: withOthers.settingsPath })).toBe(false)
		expect(await readRaw(withOthers.settingsPath)).toBe(before)
		expect(await raw()).toBeUndefined()
	})

	it("tolerates a broken JSON file", async () => {
		const { settingsPath } = await setup("{ not json")

		expect(await unregisterHarnessLogsMcpServer({ settingsPath })).toBe(false)
	})
})
