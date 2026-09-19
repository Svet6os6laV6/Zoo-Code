import * as path from "path"

import type { TaskContext } from "../../worktree/task-resolver.js"
import type { TaskState } from "../../worktree/task-state.js"
import { TaskScheduler } from "../../worktree/task-scheduler.js"
import { createInMemoryFileSystem } from "../../worktree/__tests__/helpers/in-memory-fs.js"
import { ModeRunner, parseStageOutcome } from "../index.js"

const taskRoot = path.join("/workspace", ".roo", "tasks", "SITESUP-1116")
const readmePath = path.join(taskRoot, "README.md")
const implementation = path.join(taskRoot, "implementation")
const context: TaskContext = { taskId: "SITESUP-1116", branch: "feature/SITESUP-1116", taskRoot }

function state(status: TaskState["status"], currentTask: string | null = null): TaskState {
	return {
		taskId: context.taskId,
		status,
		currentTask,
		currentTaskArtifact: currentTask ? path.join(implementation, `${currentTask}-unit.md`) : null,
	}
}

describe("ModeRunner", () => {
	it("starts the mode selected by the lifecycle controller", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: REVIEW\nCurrent Task: NONE\n",
		})
		const starts: string[] = []
		const runner = new ModeRunner(
			async (mode) => {
				starts.push(mode)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		const result = await runner.run(context, state("REVIEW"), {
			type: "start_mode",
			status: "REVIEW_PASSED",
			mode: "qa",
		})

		expect(result).toEqual({ type: "started", mode: "qa", status: "REVIEW_PASSED" })
		expect(starts).toEqual(["qa"])
		expect(fileSystem.files.get(readmePath)).toContain("Status: REVIEW_PASSED")
	})

	it("asks the scheduler for the next implementation unit before starting Code", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T01-unit.md\n",
			[path.join(implementation, "T01-unit.md")]: "## Status\nStatus: DONE\n",
			[path.join(implementation, "T02-unit.md")]:
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
		})
		const starts: string[] = []
		const runner = new ModeRunner(
			async (mode) => {
				starts.push(mode)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		const result = await runner.run(context, state("IMPLEMENTATION", "T01"), {
			type: "schedule_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})

		expect(result).toEqual({ type: "started", mode: "code", status: "IMPLEMENTATION" })
		expect(starts).toEqual(["code"])
		expect(fileSystem.files.get(readmePath)).toContain("Current Task: implementation/T02-unit.md")
	})

	it("starts Refactor when the scheduler reports every implementation unit done", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T01-unit.md\n",
			[path.join(implementation, "T01-unit.md")]: "## Status\nStatus: DONE\n",
		})
		const starts: string[] = []
		const runner = new ModeRunner(
			async (mode) => {
				starts.push(mode)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		const result = await runner.run(context, state("IMPLEMENTATION", "T01"), {
			type: "schedule_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})

		expect(result).toEqual({ type: "started", mode: "refactor", status: "READY_FOR_REFACTOR" })
		expect(starts).toEqual(["refactor"])
		expect(fileSystem.files.get(readmePath)).toContain("Status: READY_FOR_REFACTOR")
	})

	it("returns a completed fix pass to the stage that requested it", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: REVIEW\nCurrent Task: NONE\n",
		})
		const starts: string[] = []
		const runner = new ModeRunner(
			async (mode) => {
				starts.push(mode)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		const result = await runner.run(context, state("REVIEW"), {
			type: "start_mode",
			status: "READY_FOR_REVIEW",
			mode: "reviewer",
		})

		expect(result).toEqual({ type: "started", mode: "reviewer", status: "READY_FOR_REVIEW" })
		expect(starts).toEqual(["reviewer"])
		expect(fileSystem.files.get(readmePath)).toContain("Status: READY_FOR_REVIEW")
	})

	it("does not touch the README when the decision re-writes the current status", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: QA_READY\nCurrent Task: NONE\n",
		})
		const writeFile = vi.spyOn(fileSystem, "writeFile")
		const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem)

		const result = await runner.run(context, state("QA_READY"), {
			type: "stop",
			status: "QA_READY",
			reason: "pending",
		})

		expect(result).toEqual({ type: "stopped", status: "QA_READY", reason: "pending" })
		expect(writeFile).not.toHaveBeenCalled()
	})

	it("asks the stage for the outcome marker the parser reads back", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: READY_FOR_REVIEW\nCurrent Task: NONE\n",
		})
		const messages: string[] = []
		const runner = new ModeRunner(
			async (_mode, message) => {
				messages.push(message)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		await runner.run(context, state("READY_FOR_REVIEW"), {
			type: "start_mode",
			status: "REVIEW_PASSED",
			mode: "qa",
		})

		const instruction = messages[0] ?? ""
		expect(instruction).toContain("Run the qa stage for SITESUP-1116")
		expect(parseStageOutcome("qa", `${instruction}\nStage Result: PASSED`)).toEqual({
			mode: "qa",
			result: "PASSED",
		})
	})
})
