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

function state(
	status: TaskState["status"],
	currentTask: string | null = null,
	overrides: Partial<TaskState> = {},
): TaskState {
	return {
		taskId: context.taskId,
		status,
		currentTask,
		currentTaskArtifact: currentTask ? path.join(implementation, `${currentTask}-unit.md`) : null,
		failureKey: null,
		failureAttempts: 0,
		...overrides,
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
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: QA_READY\nCurrent Task: NONE\nFailure Key: NONE\nFailure Attempts: 0\n",
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

	it("completes a canonical block that is missing the failure fields", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: QA_READY\nCurrent Task: NONE\n",
		})
		const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem)

		await runner.run(context, state("QA_READY"), {
			type: "stop",
			status: "QA_READY",
			reason: "pending",
		})

		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Failure Key: NONE")
		expect(readme).toContain("Failure Attempts: 0")
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
			failureKey: null,
		})
	})

	it("persists the failure block when the controller starts a fix pass", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: READY_FOR_REVIEW\nCurrent Task: NONE\n",
		})
		const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem)

		await runner.run(context, state("READY_FOR_REVIEW"), {
			type: "start_mode",
			status: "REVIEW",
			mode: "code",
			failure: { key: "auth-token-expiry", attempts: 2 },
		})

		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: REVIEW")
		expect(readme).toContain("Failure Key: auth-token-expiry")
		expect(readme).toContain("Failure Attempts: 2")
	})

	it("clears the failure block when a stage advances", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: REVIEW\nCurrent Task: NONE\nFailure Key: auth-token-expiry\nFailure Attempts: 2\n",
		})
		const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem)

		await runner.run(context, state("REVIEW"), {
			type: "start_mode",
			status: "READY_FOR_REVIEW",
			mode: "reviewer",
		})

		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: READY_FOR_REVIEW")
		expect(readme).toContain("Failure Key: NONE")
		expect(readme).toContain("Failure Attempts: 0")
	})

	it("points Code at the assigned implementation unit", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T01-unit.md\n",
			[path.join(implementation, "T01-unit.md")]: "## Status\nStatus: DONE\n",
			[path.join(implementation, "T02-unit.md")]:
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
		})
		const messages: string[] = []
		const runner = new ModeRunner(
			async (_mode, message) => {
				messages.push(message)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		await runner.run(context, state("IMPLEMENTATION", "T01"), {
			type: "schedule_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})

		const instruction = messages[0] ?? ""
		expect(instruction).toContain("implementation/T02-unit.md")
	})

	it("parks the assigned unit and reassigns the next ready unit on RESCHEDULE_REQUIRED", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T02-unit.md\n",
			[path.join(implementation, "T02-unit.md")]:
				"## Status\nStatus: IN_PROGRESS\n\n## Relationships\n\n- Depends on: T03\n",
			[path.join(implementation, "T03-unit.md")]: "## Status\nStatus: TODO\n",
		})
		const starts: string[] = []
		const messages: string[] = []
		const runner = new ModeRunner(
			async (mode, message) => {
				starts.push(mode)
				messages.push(message)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		const result = await runner.run(context, state("IMPLEMENTATION", "T02"), {
			type: "reschedule_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})

		expect(result).toEqual({ type: "started", mode: "code", status: "IMPLEMENTATION" })
		expect(starts).toEqual(["code"])
		// The parked unit returns to TODO so the DAG can make it ready again.
		expect(fileSystem.files.get(path.join(implementation, "T02-unit.md"))).toContain("Status: TODO")
		// The scheduler recomputed the DAG and assigned the dependency.
		expect(fileSystem.files.get(readmePath)).toContain("Current Task: implementation/T03-unit.md")
		expect(messages[0] ?? "").toContain("implementation/T03-unit.md")
	})

	it("refuses a reschedule that left the unit ready, so it cannot loop", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T02-unit.md\n",
			[path.join(implementation, "T02-unit.md")]: "## Status\nStatus: IN_PROGRESS\n",
			[path.join(implementation, "T03-unit.md")]: "## Status\nStatus: TODO\n",
		})
		const starts: string[] = []
		const runner = new ModeRunner(
			async (mode) => {
				starts.push(mode)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		const result = await runner.run(context, state("IMPLEMENTATION", "T02"), {
			type: "reschedule_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})

		expect(result).toEqual({
			type: "invalid",
			reason: "Reschedule left T02 ready; no dependency was added",
		})
		expect(starts).toEqual([])
		// The README is left in a canonical, resumable state.
		expect(fileSystem.files.get(readmePath)).toContain("Status: READY_FOR_IMPLEMENTATION")
		expect(fileSystem.files.get(readmePath)).toContain("Current Task: NONE")
	})

	it("starts Refactor when a reschedule finds every unit done", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T02-unit.md\n",
			[path.join(implementation, "T02-unit.md")]: "## Status\nStatus: DONE\n",
			[path.join(implementation, "T03-unit.md")]: "## Status\nStatus: DONE\n",
		})
		const starts: string[] = []
		const runner = new ModeRunner(
			async (mode) => {
				starts.push(mode)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		const result = await runner.run(context, state("IMPLEMENTATION", "T02"), {
			type: "reschedule_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})

		expect(result).toEqual({ type: "started", mode: "refactor", status: "READY_FOR_REFACTOR" })
		expect(starts).toEqual(["refactor"])
	})

	it("writes the PLAN_READY gate without starting a mode", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: ANALYSIS\nCurrent Task: NONE\n",
		})
		const starts: string[] = []
		const runner = new ModeRunner(
			async (mode) => {
				starts.push(mode)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		const result = await runner.run(context, state("ANALYSIS"), {
			type: "stop",
			status: "PLAN_READY",
			reason: "plan-approval",
		})

		expect(result).toEqual({ type: "stopped", status: "PLAN_READY", reason: "plan-approval" })
		expect(starts).toEqual([])

		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: PLAN_READY")
		expect(readme).toContain("Current Task: NONE")
	})

	it("opens the implementation queue on plan approval and starts Code on the first ready unit", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: PLAN_READY\nCurrent Task: NONE\n",
			[path.join(implementation, "T01-unit.md")]: "## Status\nStatus: TODO\n",
		})
		const starts: string[] = []
		const runner = new ModeRunner(
			async (mode) => {
				starts.push(mode)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		const result = await runner.run(context, state("PLAN_READY"), {
			type: "resume_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})

		expect(result).toEqual({ type: "started", mode: "code", status: "IMPLEMENTATION" })
		expect(starts).toEqual(["code"])

		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: IMPLEMENTATION")
		expect(readme).toContain("Current Task: implementation/T01-unit.md")
	})

	it("starts Refactor on plan approval when every implementation unit is already done", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: PLAN_READY\nCurrent Task: NONE\n",
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

		const result = await runner.run(context, state("PLAN_READY"), {
			type: "resume_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})

		expect(result).toEqual({ type: "started", mode: "refactor", status: "READY_FOR_REFACTOR" })
		expect(starts).toEqual(["refactor"])
	})

	it("resumes a BLOCKED task, clears the blocker and assigns the next ready unit", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: BLOCKED\nCurrent Task: NONE\nFailure Key: external-blocker\nFailure Attempts: 1\n",
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

		const result = await runner.run(context, state("BLOCKED"), {
			type: "resume_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})

		expect(result).toEqual({ type: "started", mode: "code", status: "IMPLEMENTATION" })
		expect(starts).toEqual(["code"])

		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: IMPLEMENTATION")
		expect(readme).toContain("Current Task: implementation/T02-unit.md")
		expect(readme).toContain("Failure Key: NONE")
		expect(readme).toContain("Failure Attempts: 0")
	})
})
