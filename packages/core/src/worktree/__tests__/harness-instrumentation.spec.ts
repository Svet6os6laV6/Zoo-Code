import * as path from "path"

import { RecordingHarnessLogger } from "../../observability/__tests__/helpers/recording-logger.js"
import type { HarnessLoggerPort } from "../../observability/types.js"
import { ArtifactValidator } from "../artifact-validator.js"
import { TaskResolver } from "../task-resolver.js"
import { TaskScheduler } from "../task-scheduler.js"
import { TaskStateError, TaskStateResolver, type TaskState } from "../task-state.js"
import { TxxParser } from "../txx-parser.js"
import { createInMemoryFileSystem } from "./helpers/in-memory-fs.js"

const taskRoot = path.join("/workspace", ".roo", "tasks", "SITESUP-1116")
const implementation = path.join(taskRoot, "implementation")
const readmePath = path.join(taskRoot, "README.md")

const taskContext = {
	taskId: "SITESUP-1116",
	branch: "feature/SITESUP-1116-heartbeat",
	taskRoot,
}

const READY_README = `Protocol Version: 2
Task: SITESUP-1116
Status: READY_FOR_IMPLEMENTATION
Current Task: NONE
Next Step: Start implementation.
`

const DAG = {
	"T01-trigger.md": "## Status\nStatus: DONE\n",
	"T02-worker.md": "## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
}

function files(readme: string, tasks: Record<string, string> = {}): Record<string, string> {
	const base: Record<string, string> = { [readmePath]: readme }

	for (const [fileName, content] of Object.entries(tasks)) {
		base[path.join(implementation, fileName)] = content
	}

	return base
}

function state(overrides: Partial<TaskState> = {}): TaskState {
	return {
		taskId: "SITESUP-1116",
		status: "READY_FOR_IMPLEMENTATION",
		currentTask: null,
		currentTaskArtifact: null,
		failureKey: null,
		failureAttempts: 0,
		...overrides,
	}
}

function fakeFileSystem(options: { error?: Error } = {}): {
	mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>
} {
	return {
		mkdir: async (dirPath) => {
			if (options.error) {
				throw options.error
			}
			return dirPath
		},
	}
}

/** Builds a resolver with a stubbed Git port, a recording logger, and a fake file system. */
function taskResolverFor(
	branch: string | null,
	logger: HarnessLoggerPort,
	fileSystem: ReturnType<typeof fakeFileSystem> = fakeFileSystem(),
): TaskResolver {
	return new TaskResolver({ getCurrentBranch: async () => branch }, undefined, logger, fileSystem)
}

describe("TaskResolver instrumentation", () => {
	it("records a resolved decision with the branch input and the task ID result", async () => {
		const logger = new RecordingHarnessLogger()
		const resolver = taskResolverFor("feature/SITESUP-1116-heartbeat", logger)

		await resolver.resolve({ workspacePath: "/workspace" })

		const record = logger.byName("harness.task.resolve").find((entry) => entry.kind === "decision")
		expect(record).toMatchObject({ kind: "decision", level: "info", attributes: { reasonCode: "resolved" } })
		expect(record?.input).toMatchObject({ branch: "feature/SITESUP-1116-heartbeat" })
		expect(record?.result).toMatchObject({ taskId: "SITESUP-1116" })
		expect(record?.reason).toContain("extracted from the current Git branch")
	})

	it("records the task root mutation alongside the resolved decision", async () => {
		const logger = new RecordingHarnessLogger()
		const resolver = taskResolverFor("feature/SITESUP-1116-heartbeat", logger)

		await resolver.resolve({ workspacePath: "/workspace" })

		const mutation = logger.byName("harness.task.resolve").find((entry) => entry.kind === "mutation")
		expect(mutation).toMatchObject({
			kind: "mutation",
			target: path.join("/workspace", ".roo", "tasks", "SITESUP-1116"),
			attributes: { reasonCode: "task-root-ensured", taskId: "SITESUP-1116" },
		})
		expect(mutation?.stateBefore).toEqual({ existed: false })
		expect(mutation?.stateAfter).toEqual({ exists: true })
	})

	it("records the fallback decision when the branch has no task ID pattern match", async () => {
		const logger = new RecordingHarnessLogger()
		const resolver = taskResolverFor("feature/webhook-mvp", logger)

		await resolver.resolve({ workspacePath: "/workspace" })

		const record = logger.byName("harness.task.resolve").find((entry) => entry.kind === "decision")
		expect(record).toMatchObject({
			kind: "decision",
			level: "info",
			attributes: { reasonCode: "fallback-branch-name" },
		})
		expect(record?.input).toMatchObject({ branch: "feature/webhook-mvp" })
		expect(record?.result).toMatchObject({ taskId: "feature-webhook-mvp" })
		expect(record?.reason).toContain("sanitized current Git branch name")
	})

	it("records why an unresolvable branch produced no task ID", async () => {
		const logger = new RecordingHarnessLogger()
		const resolver = taskResolverFor(null, logger)

		await expect(resolver.resolve({ workspacePath: "/workspace" })).rejects.toThrow()

		const record = logger.byName("harness.task.resolve")[0]
		expect(record).toMatchObject({ level: "warn", result: null, attributes: { reasonCode: "no-branch" } })
	})

	it("records the candidates when a branch is ambiguous", async () => {
		const logger = new RecordingHarnessLogger()
		const resolver = taskResolverFor("feature/SITESUP-1116-merge-SITESUP-2222", logger)

		await expect(resolver.resolve({ workspacePath: "/workspace" })).rejects.toThrow()

		const record = logger.byName("harness.task.resolve")[0]
		expect(record).toMatchObject({ level: "warn", attributes: { reasonCode: "ambiguous-task-id" } })
		expect(record?.attributes?.candidates).toEqual(["SITESUP-1116", "SITESUP-2222"])
	})

	it("records a mkdir failure before throwing", async () => {
		const logger = new RecordingHarnessLogger()
		const resolver = taskResolverFor(
			"feature/SITESUP-1116-heartbeat",
			logger,
			fakeFileSystem({ error: new Error("EACCES: permission denied") }),
		)

		await expect(resolver.resolve({ workspacePath: "/workspace" })).rejects.toThrow()

		const record = logger.byName("harness.task.resolve")[0]
		expect(record).toMatchObject({
			level: "warn",
			result: null,
			attributes: { reasonCode: "task-root-create-failed" },
		})
		expect(record?.reason).toContain("task root directory could not be created")
	})
})

describe("TaskStateResolver instrumentation", () => {
	it("records the resolved state and the README field it came from", async () => {
		const logger = new RecordingHarnessLogger()
		const fileSystem = createInMemoryFileSystem(
			files(`Protocol Version: 2
Task: SITESUP-1116
Status: IMPLEMENTATION
Current Task: implementation/T02-worker.md
`),
		)
		const resolver = new TaskStateResolver(fileSystem, logger)

		await resolver.resolve(taskContext)

		const record = logger.byName("harness.taskState.resolve")[0]
		expect(record).toMatchObject({ kind: "decision", attributes: { reasonCode: "resolved" } })
		expect(record?.result).toMatchObject({ status: "IMPLEMENTATION", currentTask: "T02" })
	})

	it("records a missing README as the ANALYSIS fallback", async () => {
		const logger = new RecordingHarnessLogger()
		const resolver = new TaskStateResolver(createInMemoryFileSystem({}), logger)

		await resolver.resolve(taskContext)

		const record = logger.byName("harness.taskState.resolve")[0]
		expect(record).toMatchObject({ attributes: { reasonCode: "missing-readme" } })
		expect(record?.result).toMatchObject({ status: "ANALYSIS", currentTask: null })
	})

	it("records a rejected README before throwing", async () => {
		const logger = new RecordingHarnessLogger()
		const fileSystem = createInMemoryFileSystem(
			files(`Protocol Version: 2
Task: SITESUP-9999
Status: ANALYSIS
Current Task: NONE
`),
		)
		const resolver = new TaskStateResolver(fileSystem, logger)

		await expect(resolver.resolve(taskContext)).rejects.toBeInstanceOf(TaskStateError)

		const record = logger.byName("harness.taskState.resolve")[0]
		expect(record).toMatchObject({ level: "warn", result: null, attributes: { reasonCode: "identity-mismatch" } })
		expect(record?.reason).toContain("Task identity mismatch")
	})
})

describe("TxxParser instrumentation", () => {
	it("records a parse span with the DAG summary", async () => {
		const logger = new RecordingHarnessLogger()
		const parser = new TxxParser(createInMemoryFileSystem(files(READY_README, DAG)), logger)

		await parser.read(taskContext)

		const record = logger.byName("harness.txx.parse")[0]
		expect(record).toMatchObject({ kind: "span", status: "ok" })
		expect(record?.attributes).toMatchObject({
			taskCount: 2,
			duplicateIds: [],
			statuses: { DONE: 1, TODO: 1 },
		})
	})

	it("records a missing implementation directory", async () => {
		const logger = new RecordingHarnessLogger()
		const parser = new TxxParser(createInMemoryFileSystem(files(READY_README)), logger)

		await parser.read(taskContext)

		expect(logger.byName("harness.txx.parse")[0]?.attributes).toMatchObject({
			missingDirectory: true,
			taskCount: 0,
		})
	})
})

describe("ArtifactValidator instrumentation", () => {
	it("records a valid decision", async () => {
		const logger = new RecordingHarnessLogger()
		const fileSystem = createInMemoryFileSystem(
			files(READY_README, {
				...DAG,
				"../implementation-plan.md": "",
				"../handoff.md": "",
			}),
		)
		const validator = new ArtifactValidator(fileSystem, new TxxParser(fileSystem), logger)

		await validator.validate(taskContext, { status: "READY_FOR_IMPLEMENTATION" })

		const record = logger.byName("harness.artifacts.validate")[0]
		expect(record).toMatchObject({ kind: "decision", attributes: { reasonCode: "valid" } })
		expect(record?.result).toMatchObject({ valid: true })
	})

	it("records the issues that made the artifacts invalid", async () => {
		const logger = new RecordingHarnessLogger()
		const fileSystem = createInMemoryFileSystem({})
		const validator = new ArtifactValidator(fileSystem, new TxxParser(fileSystem), logger)

		await validator.validate(taskContext, { status: "IMPLEMENTATION" })

		const record = logger.byName("harness.artifacts.validate")[0]
		expect(record).toMatchObject({ level: "warn", attributes: { reasonCode: "invalid" } })
		expect(record?.result).toMatchObject({ valid: false })
		expect(record?.reason).toContain("require repair")
	})
})

describe("TaskScheduler instrumentation", () => {
	it("records the assignment decision and the README mutation", async () => {
		const logger = new RecordingHarnessLogger()
		const fileSystem = createInMemoryFileSystem(files(READY_README, DAG))
		const scheduler = new TaskScheduler(fileSystem, new TxxParser(fileSystem), logger)

		await scheduler.assignNext(taskContext, state())

		const decision = logger.byName("harness.scheduler.assignNext").find((record) => record.kind === "decision")
		expect(decision).toMatchObject({ attributes: { reasonCode: "assigned" } })
		expect(decision?.result).toMatchObject({ taskId: "T02", relativeArtifact: "implementation/T02-worker.md" })

		const mutation = logger.byName("harness.scheduler.assignNext").find((record) => record.kind === "mutation")
		expect(mutation?.target).toBe(readmePath)
		expect(mutation?.stateBefore).toEqual({
			status: "READY_FOR_IMPLEMENTATION",
			currentTask: "NONE",
			owner: null,
			nextStep: "Start implementation.",
			failureKey: null,
			failureAttempts: null,
		})
		expect(mutation?.stateAfter).toEqual({
			status: "IMPLEMENTATION",
			currentTask: "implementation/T02-worker.md",
			owner: null,
			nextStep: "Implement T02 (implementation/T02-worker.md).",
			failureKey: "NONE",
			failureAttempts: "0",
		})
	})

	it("clears a stale failure block when a fresh implementation unit is assigned", async () => {
		const logger = new RecordingHarnessLogger()
		const readmeWithFailure = `Protocol Version: 2
Task: SITESUP-1116
Status: READY_FOR_IMPLEMENTATION
Current Task: NONE
Next Step: Start implementation.
Failure Key: auth-token-expiry
Failure Attempts: 2
`
		const fileSystem = createInMemoryFileSystem(files(readmeWithFailure, DAG))
		const scheduler = new TaskScheduler(fileSystem, new TxxParser(fileSystem), logger)

		const assignment = await scheduler.assignNext(taskContext, state())

		expect(assignment?.state).toMatchObject({ failureKey: null, failureAttempts: 0 })
		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Failure Key: NONE")
		expect(readme).toContain("Failure Attempts: 0")
	})

	it("records why a lifecycle stage does not execute implementation units", async () => {
		const logger = new RecordingHarnessLogger()
		const fileSystem = createInMemoryFileSystem(files(READY_README, DAG))
		const scheduler = new TaskScheduler(fileSystem, new TxxParser(fileSystem), logger)

		await scheduler.assignNext(taskContext, state({ status: "ANALYSIS" }))

		expect(logger.byName("harness.scheduler.assignNext")[0]).toMatchObject({
			result: null,
			attributes: { reasonCode: "stage-not-implementation" },
		})
	})

	it("records a resume instead of a reassignment", async () => {
		const logger = new RecordingHarnessLogger()
		const fileSystem = createInMemoryFileSystem(
			files(READY_README, { ...DAG, "T02-worker.md": "## Status\nStatus: IN_PROGRESS\n" }),
		)
		const scheduler = new TaskScheduler(fileSystem, new TxxParser(fileSystem), logger)

		await scheduler.assignNext(
			taskContext,
			state({
				status: "IMPLEMENTATION",
				currentTask: "T02",
				currentTaskArtifact: path.join(implementation, "T02-worker.md"),
			}),
		)

		expect(logger.byName("harness.scheduler.assignNext")[0]).toMatchObject({
			result: null,
			attributes: { reasonCode: "current-unit-unfinished", currentUnitStatus: "IN_PROGRESS" },
		})
	})

	it("records a DAG with no ready unit", async () => {
		const logger = new RecordingHarnessLogger()
		const fileSystem = createInMemoryFileSystem(
			files(READY_README, {
				// T01 depends on a unit that does not exist, so it is never ready and
				// T02 stays blocked behind it.
				"T01-trigger.md": "## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T99\n",
				"T02-worker.md": "## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
			}),
		)
		const scheduler = new TaskScheduler(fileSystem, new TxxParser(fileSystem), logger)

		await scheduler.assignNext(taskContext, state())

		expect(logger.byName("harness.scheduler.assignNext")[0]).toMatchObject({
			result: null,
			attributes: { reasonCode: "no-ready-task" },
		})
	})

	it("records an unrecognized README layout instead of mutating it", async () => {
		const logger = new RecordingHarnessLogger()
		const fileSystem = createInMemoryFileSystem(files("Task: SITESUP-1116\n", DAG))
		const scheduler = new TaskScheduler(fileSystem, new TxxParser(fileSystem), logger)

		await scheduler.assignNext(taskContext, state())

		expect(logger.byName("harness.scheduler.assignNext")[0]).toMatchObject({
			result: null,
			attributes: { reasonCode: "readme-layout-unrecognized" },
		})
		expect(fileSystem.files.get(readmePath)).toBe("Task: SITESUP-1116\n")
	})
})
