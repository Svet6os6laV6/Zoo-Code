import * as path from "path"

import type { TaskContext } from "../../worktree/task-resolver.js"
import { TaskStateResolver, type TaskState } from "../../worktree/task-state.js"
import { TxxParser } from "../../worktree/txx-parser.js"
import {
	createInMemoryFileSystem,
	type InMemoryFileSystemHandle,
} from "../../worktree/__tests__/helpers/in-memory-fs.js"
import { StateReconciler, diffTaskState } from "../state-reconciler.js"
import { RecordingHarnessLogger } from "./helpers/recording-logger.js"

const taskRoot = path.join("/workspace", ".roo", "tasks", "SITESUP-1116")
const implementation = path.join(taskRoot, "implementation")
const readmePath = path.join(taskRoot, "README.md")

const taskContext: TaskContext = {
	taskId: "SITESUP-1116",
	branch: "feature/SITESUP-1116-heartbeat",
	taskRoot,
}

const README = `Protocol Version: 2
Task: SITESUP-1116
Status: IMPLEMENTATION
Current Task: implementation/T02-worker.md
Next Step: Implement T02.
`

function files(readme: string, tasks: Record<string, string> = {}): Record<string, string> {
	const base: Record<string, string> = { [readmePath]: readme }

	for (const [fileName, content] of Object.entries(tasks)) {
		base[path.join(implementation, fileName)] = content
	}

	return base
}

function reconcilerFor(fileSystem: InMemoryFileSystemHandle, logger: RecordingHarnessLogger): StateReconciler {
	return new StateReconciler(fileSystem, new TxxParser(fileSystem), new TaskStateResolver(fileSystem), logger)
}

function runtimeState(overrides: Partial<TaskState> = {}): TaskState {
	return {
		taskId: "SITESUP-1116",
		status: "IMPLEMENTATION",
		currentTask: "T02",
		currentTaskArtifact: path.join(implementation, "T02-worker.md"),
		failureKey: null,
		failureAttempts: 0,
		...overrides,
	}
}

const DAG = {
	"T02-worker.md": "## Status\nStatus: IN_PROGRESS\n",
}

describe("diffTaskState", () => {
	it("returns no differences for identical states", () => {
		expect(diffTaskState(runtimeState(), runtimeState())).toEqual([])
	})

	it("reports each diverging field", () => {
		const differences = diffTaskState(
			runtimeState({ status: "IMPLEMENTATION", currentTask: "T02" }),
			runtimeState({ status: "REVIEW", currentTask: "T03", currentTaskArtifact: "/other/T03.md" }),
		)

		expect(differences.map((difference) => difference.field)).toEqual([
			"status",
			"currentTask",
			"currentTaskArtifact",
		])
	})
})

describe("StateReconciler", () => {
	it("reports a consistent state when runtime matches the canonical artifacts", async () => {
		const fileSystem = createInMemoryFileSystem(files(README, DAG))
		const logger = new RecordingHarnessLogger()

		const result = await reconcilerFor(fileSystem, logger).reconcile(taskContext, runtimeState(), {
			phase: "scheduler.assignNext",
		})

		expect(result.consistent).toBe(true)
		expect(result.differences).toEqual([])
		expect(result.canonical?.currentTask).toBe("T02")

		const record = logger.byName("harness.state.reconcile")[0]
		expect(record?.level).toBe("debug")
		expect(record?.attributes).toMatchObject({
			phase: "scheduler.assignNext",
			consistent: true,
			differenceCount: 0,
		})
	})

	it("reports a runtime state that drifted from the canonical README", async () => {
		const fileSystem = createInMemoryFileSystem(files(README, DAG))
		const logger = new RecordingHarnessLogger()

		const result = await reconcilerFor(fileSystem, logger).reconcile(
			taskContext,
			runtimeState({ status: "REVIEW", currentTask: "T03" }),
			{ phase: "mode.transition" },
		)

		expect(result.consistent).toBe(false)
		// The drifted unit is also absent from implementation/, which is reported
		// as its own difference.
		expect(result.differences.map((difference) => difference.field)).toEqual([
			"status",
			"currentTask",
			"currentTask-unit",
		])

		const record = logger.byName("harness.state.reconcile")[0]
		expect(record?.level).toBe("warn")
		expect(record?.attributes).toMatchObject({ phase: "mode.transition", differenceCount: 3 })
	})

	it("reports a missing canonical README as a difference instead of throwing", async () => {
		const fileSystem = createInMemoryFileSystem({})
		const logger = new RecordingHarnessLogger()

		const result = await reconcilerFor(fileSystem, logger).reconcile(taskContext, runtimeState(), {
			phase: "task.start",
		})

		expect(result.consistent).toBe(false)
		expect(result.differences.map((difference) => difference.field)).toContain("status")
		expect(result.canonical?.status).toBe("ANALYSIS")
	})

	it("reports a malformed canonical README as a difference instead of throwing", async () => {
		const fileSystem = createInMemoryFileSystem(
			files(
				`Protocol Version: 2
Task: SITESUP-9999
Status: IMPLEMENTATION
Current Task: implementation/T02-worker.md
`,
				DAG,
			),
		)
		const logger = new RecordingHarnessLogger()

		const result = await reconcilerFor(fileSystem, logger).reconcile(taskContext, runtimeState(), {
			phase: "task.start",
		})

		expect(result.consistent).toBe(false)
		expect(result.canonical).toBeNull()
		expect(result.differences[0]?.field).toBe("canonical-readme")
		expect(result.differences[0]?.message).toContain("Task identity mismatch")
	})

	it("reports an assigned unit that is missing from implementation/", async () => {
		const fileSystem = createInMemoryFileSystem(files(README))
		const logger = new RecordingHarnessLogger()

		const result = await reconcilerFor(fileSystem, logger).reconcile(taskContext, runtimeState(), {
			phase: "scheduler.assignNext",
		})

		expect(result.consistent).toBe(false)
		expect(result.differences.map((difference) => difference.field)).toContain("currentTask-unit")
	})

	it("reports an assigned unit with an unusable status", async () => {
		const fileSystem = createInMemoryFileSystem(files(README, { "T02-worker.md": "## Status\nStatus: BROKEN\n" }))
		const logger = new RecordingHarnessLogger()

		const result = await reconcilerFor(fileSystem, logger).reconcile(taskContext, runtimeState(), {
			phase: "scheduler.assignNext",
		})

		expect(result.differences.map((difference) => difference.field)).toContain("currentTask-unit-status")
	})

	it("reports an unexpected file system failure as a difference instead of throwing", async () => {
		const fileSystem = createInMemoryFileSystem(files(README, DAG))
		const failing = {
			...fileSystem,
			readdir: async () => {
				throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
			},
		}
		const logger = new RecordingHarnessLogger()

		const result = await reconcilerFor(failing, logger).reconcile(taskContext, runtimeState(), {
			phase: "task.start",
		})

		expect(result.consistent).toBe(false)
		expect(result.differences.map((difference) => difference.field)).toContain("implementation-artifacts")
	})
})
