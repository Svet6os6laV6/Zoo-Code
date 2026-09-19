import * as path from "path"

import type { TaskContext } from "../task-resolver.js"
import type { TaskState } from "../task-state.js"
import { TaskScheduler } from "../task-scheduler.js"
import { parseImplementationTask, type ImplementationArtifacts } from "../txx-parser.js"
import { createInMemoryFileSystem, type InMemoryFileSystemHandle } from "./helpers/in-memory-fs.js"

const taskRoot = path.join("/workspace", ".roo", "tasks", "SITESUP-1116")
const implementation = path.join(taskRoot, "implementation")
const readmePath = path.join(taskRoot, "README.md")

const taskContext: TaskContext = {
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

function files(readme: string, tasks: Record<string, string>): Record<string, string> {
	const base: Record<string, string> = { [readmePath]: readme }

	for (const [fileName, content] of Object.entries(tasks)) {
		base[path.join(implementation, fileName)] = content
	}

	return base
}

function schedulerFor(
	readme: string,
	tasks: Record<string, string>,
): {
	scheduler: TaskScheduler
	fileSystem: InMemoryFileSystemHandle
} {
	const fileSystem = createInMemoryFileSystem(files(readme, tasks))

	return { scheduler: new TaskScheduler(fileSystem), fileSystem }
}

const DAG = {
	"T01-trigger.md": "## Status\nStatus: DONE\n",
	"T02-worker.md": "## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
	"T03-reconciler.md": "## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
	"T04-integration.md": "## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T02, T03\n",
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

describe("TaskScheduler.plan", () => {
	it("exposes the ready set and the remaining DAG buckets", async () => {
		const { scheduler } = schedulerFor(READY_README, DAG)
		const plan = await scheduler.plan(taskContext)

		expect(plan.ready.map((task) => task.id)).toEqual(["T02", "T03"])
		expect(plan.done.map((task) => task.id)).toEqual(["T01"])
		expect(plan.blocked).toEqual([])
		expect(plan.inProgress).toEqual([])
	})
})

describe("TaskScheduler.assignNext", () => {
	it("assigns the first ready unit and writes it into the README", async () => {
		const { scheduler, fileSystem } = schedulerFor(READY_README, DAG)
		const assignment = await scheduler.assignNext(taskContext, state())

		expect(assignment).toMatchObject({
			relativeArtifact: "implementation/T02-worker.md",
			replaced: null,
			state: {
				taskId: "SITESUP-1116",
				status: "IMPLEMENTATION",
				currentTask: "T02",
				currentTaskArtifact: path.join(implementation, "T02-worker.md"),
			},
		})
		expect(fileSystem.files.get(readmePath)).toBe(`Protocol Version: 2
Task: SITESUP-1116
Status: IMPLEMENTATION
Current Task: implementation/T02-worker.md
Next Step: Implement T02 (implementation/T02-worker.md).
`)
		expect([...fileSystem.files.keys()].some((filePath) => filePath.endsWith(".tmp"))).toBe(false)
	})

	it("keeps an unfinished assignment instead of reassigning it", async () => {
		const { scheduler, fileSystem } = schedulerFor(READY_README, DAG)
		const assignment = await scheduler.assignNext(
			taskContext,
			state({
				status: "IMPLEMENTATION",
				currentTask: "T02",
				currentTaskArtifact: path.join(implementation, "T02-worker.md"),
			}),
		)

		expect(assignment).toBeNull()
		expect(fileSystem.files.get(readmePath)).toBe(READY_README)
	})

	it("assigns the next unit after the current one finished", async () => {
		const { scheduler } = schedulerFor(READY_README, {
			...DAG,
			"T02-worker.md": "## Status\nStatus: DONE\n\n## Relationships\n\n- Depends on: T01\n",
		})
		const assignment = await scheduler.assignNext(
			taskContext,
			state({
				status: "IMPLEMENTATION",
				currentTask: "T02",
				currentTaskArtifact: path.join(implementation, "T02-worker.md"),
			}),
		)

		expect(assignment).toMatchObject({
			relativeArtifact: "implementation/T03-reconciler.md",
			replaced: "T02",
			state: { currentTask: "T03" },
		})
	})

	it("does not assign anything when no unit is ready", async () => {
		const { scheduler, fileSystem } = schedulerFor(READY_README, {
			"T01-trigger.md": "## Status\nStatus: IN_PROGRESS\n",
			"T02-worker.md": "## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
		})
		const assignment = await scheduler.assignNext(taskContext, state())

		expect(assignment).toBeNull()
		expect(fileSystem.files.get(readmePath)).toBe(READY_README)
	})

	it("does not assign outside the implementation stages", async () => {
		const { scheduler } = schedulerFor(READY_README, DAG)

		await expect(scheduler.assignNext(taskContext, state({ status: "ANALYSIS" }))).resolves.toBeNull()
		await expect(scheduler.assignNext(taskContext, state({ status: "REVIEW" }))).resolves.toBeNull()
	})

	it("does not reassign when the current unit artifact is missing", async () => {
		const { scheduler, fileSystem } = schedulerFor(READY_README, DAG)
		const assignment = await scheduler.assignNext(
			taskContext,
			state({
				status: "IMPLEMENTATION",
				currentTask: "T09",
				currentTaskArtifact: path.join(implementation, "T09-missing.md"),
			}),
		)

		expect(assignment).toBeNull()
		expect(fileSystem.files.get(readmePath)).toBe(READY_README)
	})

	it("does not mutate a README without a canonical Status line", async () => {
		const readme = "Task: SITESUP-1116\nCurrent Task: NONE\n"
		const { scheduler, fileSystem } = schedulerFor(readme, DAG)
		const assignment = await scheduler.assignNext(taskContext, state())

		expect(assignment).toBeNull()
		expect(fileSystem.files.get(readmePath)).toBe(readme)
	})

	it("inserts the missing canonical fields when a legacy README lacks them", async () => {
		const readme = "Protocol Version: 2\nTask: SITESUP-1116\nStatus: READY_FOR_IMPLEMENTATION\n"
		const { scheduler, fileSystem } = schedulerFor(readme, DAG)
		const assignment = await scheduler.assignNext(taskContext, state())

		expect(assignment).toMatchObject({ relativeArtifact: "implementation/T02-worker.md" })
		expect(fileSystem.files.get(readmePath)).toBe(`Protocol Version: 2
Task: SITESUP-1116
Status: IMPLEMENTATION
Current Task: implementation/T02-worker.md
Next Step: Implement T02 (implementation/T02-worker.md).
`)
	})

	it("assigns from the provided snapshot without re-reading implementation/", async () => {
		const { scheduler, fileSystem } = schedulerFor(READY_README, DAG)
		const provided: ImplementationArtifacts = {
			directory: implementation,
			missingDirectory: false,
			tasks: [
				parseImplementationTask(
					"T01-trigger.md",
					path.join(implementation, "T01-trigger.md"),
					"## Status\nStatus: DONE\n",
				),
				parseImplementationTask(
					"T09-provided.md",
					path.join(implementation, "T09-provided.md"),
					"## Status\nStatus: TODO\n",
				),
			],
			duplicateIds: [],
			unexpectedFiles: [],
		}

		const assignment = await scheduler.assignNext(taskContext, state(), provided)

		// T02/T03 exist on disk but not in the snapshot, so T09 is the only ready unit.
		expect(assignment).toMatchObject({ relativeArtifact: "implementation/T09-provided.md" })
		expect(fileSystem.files.get(readmePath)).toContain("Current Task: implementation/T09-provided.md")
	})
})
