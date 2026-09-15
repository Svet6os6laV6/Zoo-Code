import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { getRootHarnessLogger, resetRootHarnessLogger } from "@roo-code/core"

import { HARNESS_LOG_DIRECTORY, createHarnessSessionId, initializeHarnessLogging } from "../harness-logging"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn(async (defaultPath: string) => defaultPath),
}))

function channel(): { lines: string[]; appendLine: (value: string) => void } {
	const lines: string[] = []

	return {
		lines,
		appendLine: (value) => {
			lines.push(value)
		},
	}
}

describe("createHarnessSessionId", () => {
	it("produces a sortable, collision-resistant id", () => {
		const id = createHarnessSessionId(new Date("2026-01-02T03:04:05.678Z"), () => 0.5)

		expect(id).toBe("2026-01-02T03-04-05-678Z-7fffffff")
	})

	it("differs for different random draws", () => {
		const now = new Date("2026-01-02T03:04:05.678Z")

		expect(createHarnessSessionId(now, () => 0.1)).not.toBe(createHarnessSessionId(now, () => 0.9))
	})
})

describe("initializeHarnessLogging", () => {
	afterEach(() => {
		resetRootHarnessLogger()
	})

	it("installs the root logger and reports the session on the harness channel", async () => {
		const output = channel()
		const handle = await initializeHarnessLogging({
			globalStoragePath: "/storage",
			channel: output,
			sessionId: "session-1",
		})

		expect(getRootHarnessLogger()).toBe(handle.logger)
		expect(handle.sessionId).toBe("session-1")
		expect(handle.jsonlPath).toBe(path.join("/storage", HARNESS_LOG_DIRECTORY, "session-1.jsonl"))
	})

	it("writes records with their structured payload to the harness output channel", async () => {
		const output = channel()
		const handle = await initializeHarnessLogging({
			globalStoragePath: "/storage",
			channel: output,
			sessionId: "session-1",
		})

		handle.logger.decision("harness.task.resolve", {
			input: { branch: "feature/SITESUP-1116-heartbeat" },
			result: { taskId: "SITESUP-1116" },
			reason: "task ID extracted from the current Git branch",
			attributes: { reasonCode: "resolved" },
			context: { taskId: "SITESUP-1116" },
		})

		expect(output.lines).toHaveLength(1)
		expect(output.lines[0]).toContain("decision harness.task.resolve")
		expect(output.lines[0]).toContain("session=session-1")
		expect(output.lines[0]).toContain("task=SITESUP-1116")
		// The channel is the human-facing surface: the payload must be visible here,
		// not only in the JSONL file.
		expect(output.lines[0]).toContain('"input":{"branch":"feature/SITESUP-1116-heartbeat"}')
		expect(output.lines[0]).toContain('"result":{"taskId":"SITESUP-1116"}')
		expect(output.lines[0]).toContain('"attributes":{"reasonCode":"resolved"}')
	})

	it("appends one JSON line per record to the session file", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "harness-logging-"))

		try {
			const handle = await initializeHarnessLogging({
				globalStoragePath: storagePath,
				channel: channel(),
				sessionId: "session-1",
			})

			handle.logger.event("harness.prompt.assemble", { attributes: { promptLength: 42 } })
			handle.logger.mutation("harness.scheduler.assignNext", {
				target: "README.md",
				stateBefore: { status: "READY_FOR_IMPLEMENTATION" },
				stateAfter: { status: "IMPLEMENTATION" },
				reason: "wrote the canonical assignment",
			})
			await handle.flush()

			const content = await fs.readFile(handle.jsonlPath, "utf8")
			const records = content
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line))

			expect(records).toHaveLength(2)
			expect(records[0]).toMatchObject({
				kind: "event",
				name: "harness.prompt.assemble",
				context: { sessionId: "session-1" },
			})
			expect(records[1]).toMatchObject({
				kind: "mutation",
				name: "harness.scheduler.assignNext",
				stateBefore: { status: "READY_FOR_IMPLEMENTATION" },
				stateAfter: { status: "IMPLEMENTATION" },
			})
		} finally {
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})
})
