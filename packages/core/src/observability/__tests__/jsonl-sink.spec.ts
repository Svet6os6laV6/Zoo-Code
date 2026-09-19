import { JsonlSink, type JsonlSinkFileSystem } from "../jsonl-sink.js"
import type { HarnessLogRecord } from "../types.js"

const FILE_PATH = "/storage/harness-logs/session-1.jsonl"

type FakeFileSystem = JsonlSinkFileSystem & {
	readonly files: Map<string, string>
	readonly mkdirCalls: string[]
}

function createFakeFileSystem(initial: Record<string, string> = {}): FakeFileSystem {
	const files = new Map(Object.entries(initial))
	const mkdirCalls: string[] = []

	return {
		files,
		mkdirCalls,
		mkdir: async (dirPath) => {
			mkdirCalls.push(dirPath)
			return undefined
		},
		appendFile: async (filePath, data) => {
			files.set(filePath, (files.get(filePath) ?? "") + data)
		},
		stat: async (filePath) => {
			const content = files.get(filePath)
			if (content === undefined) {
				throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" })
			}
			return { size: Buffer.byteLength(content, "utf8") }
		},
		rename: async (oldPath, newPath) => {
			const content = files.get(oldPath)
			if (content === undefined) {
				throw Object.assign(new Error(`ENOENT: ${oldPath}`), { code: "ENOENT" })
			}
			files.delete(oldPath)
			files.set(newPath, content)
		},
		rm: async (filePath) => {
			files.delete(filePath)
		},
	}
}

function record(name: string, payload: string = "x".repeat(80)): HarnessLogRecord {
	return {
		kind: "event",
		name,
		level: "info",
		timestamp: "2026-01-01T00:00:00.000Z",
		context: {
			traceId: "trace-1",
			spanId: "span-1",
			sessionId: "session-1",
			taskId: null,
			agentTaskId: null,
			txxId: null,
			mode: null,
		},
		attributes: { payload },
	}
}

function lines(fileSystem: FakeFileSystem, filePath: string): string[] {
	return (fileSystem.files.get(filePath) ?? "").split("\n").filter((line) => line.length > 0)
}

describe("JsonlSink", () => {
	it("writes one JSON line per record and creates the directory lazily", async () => {
		const fileSystem = createFakeFileSystem()
		const sink = new JsonlSink({ filePath: FILE_PATH, fileSystem })

		sink.write(record("harness.first"))
		sink.write(record("harness.second"))
		await sink.flush()

		const written = lines(fileSystem, FILE_PATH)
		expect(written).toHaveLength(2)
		expect(JSON.parse(written[0] ?? "{}").name).toBe("harness.first")
		expect(JSON.parse(written[1] ?? "{}").name).toBe("harness.second")
		expect(fileSystem.mkdirCalls).toEqual(["/storage/harness-logs"])
	})

	it("serializes concurrent writes in call order", async () => {
		const fileSystem = createFakeFileSystem()
		const sink = new JsonlSink({ filePath: FILE_PATH, fileSystem })

		for (let index = 0; index < 20; index += 1) {
			sink.write(record(`harness.${index}`))
		}
		await sink.flush()

		expect(lines(fileSystem, FILE_PATH).map((line) => JSON.parse(line).name)).toEqual(
			Array.from({ length: 20 }, (_value, index) => `harness.${index}`),
		)
	})

	it("rotates the active file once it would exceed maxBytes", async () => {
		const fileSystem = createFakeFileSystem()
		const sink = new JsonlSink({ filePath: FILE_PATH, fileSystem, maxBytes: 100, maxArchives: 3 })

		sink.write(record("harness.first"))
		sink.write(record("harness.second"))
		sink.write(record("harness.third"))
		await sink.flush()

		expect(lines(fileSystem, FILE_PATH).map((line) => JSON.parse(line).name)).toEqual(["harness.third"])
		expect(lines(fileSystem, `${FILE_PATH}.1`).map((line) => JSON.parse(line).name)).toEqual(["harness.second"])
		expect(lines(fileSystem, `${FILE_PATH}.2`).map((line) => JSON.parse(line).name)).toEqual(["harness.first"])
	})

	it("keeps at most maxArchives rotated files", async () => {
		const fileSystem = createFakeFileSystem()
		const sink = new JsonlSink({ filePath: FILE_PATH, fileSystem, maxBytes: 100, maxArchives: 1 })

		sink.write(record("harness.first"))
		sink.write(record("harness.second"))
		sink.write(record("harness.third"))
		await sink.flush()

		expect(lines(fileSystem, FILE_PATH).map((line) => JSON.parse(line).name)).toEqual(["harness.third"])
		expect(lines(fileSystem, `${FILE_PATH}.1`).map((line) => JSON.parse(line).name)).toEqual(["harness.second"])
		expect(fileSystem.files.has(`${FILE_PATH}.2`)).toBe(false)
	})

	it("truncates instead of archiving when maxArchives is zero", async () => {
		const fileSystem = createFakeFileSystem()
		const sink = new JsonlSink({ filePath: FILE_PATH, fileSystem, maxBytes: 100, maxArchives: 0 })

		sink.write(record("harness.first"))
		sink.write(record("harness.second"))
		await sink.flush()

		expect(lines(fileSystem, FILE_PATH).map((line) => JSON.parse(line).name)).toEqual(["harness.second"])
		expect(fileSystem.files.has(`${FILE_PATH}.1`)).toBe(false)
	})

	it("reports an unserializable record without breaking the queue", async () => {
		const fileSystem = createFakeFileSystem()
		const errors: unknown[] = []
		const sink = new JsonlSink({ filePath: FILE_PATH, fileSystem, onError: (error) => errors.push(error) })

		const broken = { ...record("harness.broken"), attributes: { big: 10n } } as unknown as HarnessLogRecord
		sink.write(broken)
		sink.write(record("harness.after"))
		await sink.flush()

		expect(errors).toHaveLength(1)
		expect(lines(fileSystem, FILE_PATH).map((line) => JSON.parse(line).name)).toEqual(["harness.after"])
	})

	it("reports an append failure without rejecting the caller", async () => {
		const fileSystem = createFakeFileSystem()
		const errors: unknown[] = []
		const failing: JsonlSinkFileSystem = {
			...fileSystem,
			appendFile: async () => {
				throw new Error("disk full")
			},
		}
		const sink = new JsonlSink({ filePath: FILE_PATH, fileSystem: failing, onError: (error) => errors.push(error) })

		expect(() => sink.write(record("harness.first"))).not.toThrow()
		await sink.flush()

		expect(errors).toHaveLength(1)
	})

	it("stops accepting writes after close", async () => {
		const fileSystem = createFakeFileSystem()
		const sink = new JsonlSink({ filePath: FILE_PATH, fileSystem })

		sink.write(record("harness.first"))
		await sink.close()
		sink.write(record("harness.second"))
		await sink.flush()

		expect(lines(fileSystem, FILE_PATH).map((line) => JSON.parse(line).name)).toEqual(["harness.first"])
	})
})
