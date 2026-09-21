import * as path from "path"

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
import { createInMemoryFileSystem } from "./helpers/in-memory-fs.js"

const taskRoot = path.join("/workspace", ".roo", "tasks", "SITESUP-1116")
const canonicalReadme = `Protocol Version: 2
Task: SITESUP-1116
Status: READY_FOR_IMPLEMENTATION
Current Task: NONE
Next Step: Start implementation.
`

describe("canonical README block", () => {
	it("reads canonical values regardless of casing and surrounding whitespace", () => {
		const readme =
			"protocol version: 2\n  status:   REVIEW_PASSED  \ncurrent task: NONE\nnext step: Ship it.\nfailure key: auth-token-expiry\nfailure attempts: 2\n"

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
