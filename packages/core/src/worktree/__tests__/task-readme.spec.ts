import * as path from "path"

import { TaskScheduler } from "../task-scheduler.js"
import type { TaskContext } from "../task-resolver.js"
import type { TaskState } from "../task-state.js"
import {
	CanonicalReadmeError,
	CanonicalReadmeWriter,
	clearedFailureFields,
	NO_FAILURE_ATTEMPTS,
	NO_FAILURE_KEY,
	readmePath,
	readCanonicalFields,
	writeCanonicalFields,
	writeReadmeAtomic,
} from "../task-readme.js"
import { parseImplementationTask, type ImplementationArtifacts } from "../txx-parser.js"
import { createInMemoryFileSystem, type InMemoryFileSystemHandle } from "./helpers/in-memory-fs.js"

const taskRoot = path.join("/workspace", ".roo", "tasks", "SITESUP-1116")
const canonicalReadme = `Protocol Version: 2
Task: SITESUP-1116
Status: READY_FOR_IMPLEMENTATION
Current Task: NONE
Next Step: Start implementation.
`

const taskContext: TaskContext = {
	taskId: "SITESUP-1116",
	branch: "feature/SITESUP-1116-heartbeat",
	taskRoot,
}

function readyState(): TaskState {
	return {
		taskId: "SITESUP-1116",
		status: "READY_FOR_IMPLEMENTATION",
		currentTask: null,
		currentTaskArtifact: null,
		failureKey: null,
		failureAttempts: 0,
	}
}

/**
 * Wraps the in-memory file system so every operation yields a microtask before
 * touching the map. Two writers started together therefore interleave their
 * read-modify-write steps unless the README lock serializes them. Microtasks
 * (not timers) keep the test deterministic and free of real timers.
 */
function createInterleavingFileSystem(initial: Record<string, string>): InMemoryFileSystemHandle {
	const base = createInMemoryFileSystem(initial)
	const yieldToQueue = () => Promise.resolve()

	return {
		files: base.files,
		readFile: async (filePath, encoding) => {
			await yieldToQueue()
			return base.readFile(filePath, encoding)
		},
		readdir: async (dirPath) => {
			await yieldToQueue()
			return base.readdir(dirPath)
		},
		writeFile: async (filePath, data, encoding) => {
			await yieldToQueue()
			return base.writeFile(filePath, data, encoding)
		},
		rename: async (oldPath, newPath) => {
			await yieldToQueue()
			return base.rename(oldPath, newPath)
		},
	}
}

describe("canonical README block", () => {
	it("reads canonical values regardless of casing and surrounding whitespace", () => {
		// A legacy `Owner:` line is unknown to the canonical block and must not
		// surface as a field, but it must not break the read either.
		const readme =
			"protocol version: 2\n  status:   REVIEW_PASSED  \ncurrent task: NONE\nowner: code#01a0ccee\nnext step: Ship it.\nfailure key: auth-token-expiry\nfailure attempts: 2\n"

		expect(readCanonicalFields(readme)).toEqual({
			status: "REVIEW_PASSED",
			currentTask: "NONE",
			nextStep: "Ship it.",
			failureKey: "auth-token-expiry",
			failureAttempts: "2",
		})
	})

	it("reports missing failure fields as null", () => {
		expect(readCanonicalFields(canonicalReadme)).toEqual({
			status: "READY_FOR_IMPLEMENTATION",
			currentTask: "NONE",
			nextStep: "Start implementation.",
			failureKey: null,
			failureAttempts: null,
		})
	})

	it("inserts a missing failure block after the Status anchor", () => {
		const updated = writeCanonicalFields(canonicalReadme, {
			"Failure Key": "auth-token-expiry",
			"Failure Attempts": "1",
		})

		expect(updated).toBe(`Protocol Version: 2
Task: SITESUP-1116
Status: READY_FOR_IMPLEMENTATION
Failure Key: auth-token-expiry
Failure Attempts: 1
Current Task: NONE
Next Step: Start implementation.
`)
	})

	it("always emits the canonical sentinels, so the block is cleared or completed", () => {
		// The function is input-independent on purpose: a lifecycle decision that
		// advances past a failure must complete the protocol v2 block even when the
		// README never had a failure field.
		expect(clearedFailureFields()).toEqual({
			"Failure Key": NO_FAILURE_KEY,
			"Failure Attempts": NO_FAILURE_ATTEMPTS,
		})
	})

	it("rewrites only the named fields and preserves every other line", () => {
		const updated = writeCanonicalFields(canonicalReadme, { Status: "REVIEW", "Current Task": "NONE" })

		expect(updated).toBe(`Protocol Version: 2
Task: SITESUP-1116
Status: REVIEW
Current Task: NONE
Next Step: Start implementation.
`)
	})

	it("inserts a missing field after Status in canonical order", () => {
		const updated = writeCanonicalFields("Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\n", {
			Status: "IMPLEMENTATION",
			"Current Task": "implementation/T02-worker.md",
			"Next Step": "Implement T02 (implementation/T02-worker.md).",
		})

		expect(updated).toBe(`Protocol Version: 2
Task: SITESUP-1116
Status: IMPLEMENTATION
Current Task: implementation/T02-worker.md
Next Step: Implement T02 (implementation/T02-worker.md).
`)
	})

	it("leaves a README without a canonical Status line untouched", () => {
		expect(writeCanonicalFields("Task: SITESUP-1116\nCurrent Task: NONE\n", { Status: "DONE" })).toBeNull()
	})

	it("writes through a temporary file and renames it into place", async () => {
		const fileSystem = createInMemoryFileSystem({ "/task/README.md": canonicalReadme })

		await writeReadmeAtomic(fileSystem, "/task/README.md", "Status: DONE\n")

		expect(fileSystem.files.get("/task/README.md")).toBe("Status: DONE\n")
		expect([...fileSystem.files.keys()]).toEqual(["/task/README.md"])
	})
})

describe("CanonicalReadmeWriter", () => {
	it("updates the canonical block and reports the observed values", async () => {
		const fileSystem = createInMemoryFileSystem({ [readmePath(taskRoot)]: canonicalReadme })
		const writer = new CanonicalReadmeWriter(fileSystem)

		const update = await writer.update(taskRoot, { Status: "REVIEW_PASSED", "Current Task": "NONE" })

		expect(update.filePath).toBe(readmePath(taskRoot))
		expect(update.before).toEqual({
			status: "READY_FOR_IMPLEMENTATION",
			currentTask: "NONE",
			nextStep: "Start implementation.",
			failureKey: null,
			failureAttempts: null,
		})
		expect(update.after).toEqual({
			status: "REVIEW_PASSED",
			currentTask: "NONE",
			nextStep: "Start implementation.",
			failureKey: null,
			failureAttempts: null,
		})
		expect(fileSystem.files.get(readmePath(taskRoot))).toContain("Status: REVIEW_PASSED")
	})

	it("rejects a README without a canonical Status field", async () => {
		const fileSystem = createInMemoryFileSystem({ [readmePath(taskRoot)]: "Task: SITESUP-1116\n" })
		const writer = new CanonicalReadmeWriter(fileSystem)

		await expect(writer.update(taskRoot, { Status: "DONE" })).rejects.toThrow(CanonicalReadmeError)
		expect(fileSystem.files.get(readmePath(taskRoot))).toBe("Task: SITESUP-1116\n")
	})
})

describe("canonical README serialization", () => {
	it("serializes concurrent updates of the same task root so neither is lost", async () => {
		const fileSystem = createInterleavingFileSystem({ [readmePath(taskRoot)]: canonicalReadme })
		const writer = new CanonicalReadmeWriter(fileSystem)

		const [statusUpdate, taskUpdate] = await Promise.all([
			writer.update(taskRoot, { Status: "REVIEW_PASSED" }),
			writer.update(taskRoot, { "Current Task": "implementation/T02-worker.md" }),
		])

		expect(statusUpdate.after.status).toBe("REVIEW_PASSED")
		expect(taskUpdate.after.currentTask).toBe("implementation/T02-worker.md")

		const final = readCanonicalFields(fileSystem.files.get(readmePath(taskRoot)) ?? "")
		expect(final.status).toBe("REVIEW_PASSED")
		expect(final.currentTask).toBe("implementation/T02-worker.md")
		// The unique temporary file is renamed away, never left behind.
		expect([...fileSystem.files.keys()]).toEqual([readmePath(taskRoot)])
	})

	it("serializes a concurrent update and assignNext on the same task root", async () => {
		const fileSystem = createInterleavingFileSystem({ [readmePath(taskRoot)]: canonicalReadme })
		const writer = new CanonicalReadmeWriter(fileSystem)
		const scheduler = new TaskScheduler(fileSystem)

		const artifacts: ImplementationArtifacts = {
			directory: path.join(taskRoot, "implementation"),
			missingDirectory: false,
			tasks: [
				parseImplementationTask(
					"T02-worker.md",
					path.join(taskRoot, "implementation", "T02-worker.md"),
					"## Status\nStatus: TODO\n",
				),
			],
			duplicateIds: [],
			unexpectedFiles: [],
		}

		const [update, assignment] = await Promise.all([
			// Both writers read-modify-write the same README, so without the lock
			// one of the two mutations can be lost.
			writer.update(taskRoot, { "Next Step": "custom step" }),
			scheduler.assignNext(taskContext, readyState(), artifacts),
		])

		expect(update.after.nextStep).toBe("custom step")
		expect(assignment).not.toBeNull()

		const final = readCanonicalFields(fileSystem.files.get(readmePath(taskRoot)) ?? "")
		// The assignment must survive the concurrent writer.
		expect(final.currentTask).toBe("implementation/T02-worker.md")
		expect([...fileSystem.files.keys()]).toEqual([readmePath(taskRoot)])
	})
})
