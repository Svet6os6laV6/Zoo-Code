import * as path from "path"

import { RecordingHarnessLogger } from "../../observability/__tests__/helpers/recording-logger.js"
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
		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: REVIEW_PASSED")
		// The runner refreshes the human-facing pointer in the same write.
		expect(readme).toContain("Next Step: Run the qa stage.")
	})

	it("does not advance the README when the stage cannot be created", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: REVIEW\nCurrent Task: NONE\n",
		})
		const runner = new ModeRunner(
			async () => {
				throw new Error("stage creation failed")
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		await expect(
			runner.run(context, state("REVIEW"), {
				type: "start_mode",
				status: "REVIEW_PASSED",
				mode: "qa",
			}),
		).rejects.toThrow("stage creation failed")

		// The stage never ran, so the canonical state must not claim it did.
		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: REVIEW")
		expect(readme).not.toContain("REVIEW_PASSED")
	})

	it("logs and rethrows when the status write fails after the stage started", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: REVIEW\nCurrent Task: NONE\n",
		})
		const starts: string[] = []
		const logger = new RecordingHarnessLogger()
		const runner = new ModeRunner(
			async (mode) => {
				starts.push(mode)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
			logger,
		)
		vi.spyOn(fileSystem, "writeFile").mockRejectedValue(new Error("disk full"))

		await expect(
			runner.run(context, state("REVIEW"), {
				type: "start_mode",
				status: "REVIEW_PASSED",
				mode: "qa",
			}),
		).rejects.toThrow("disk full")

		// The stage is already running; the failure is diagnosable but not rolled back.
		expect(starts).toEqual(["qa"])
		const failed = logger.byName("harness.lifecycle.write-after-start")
		expect(failed).toHaveLength(1)
		expect(failed[0]).toMatchObject({
			kind: "decision",
			level: "error",
			attributes: { reasonCode: "write-after-start-failed" },
		})
	})

	it("leaves the assignment resumable when Code cannot be started", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T01-unit.md\n",
			[path.join(implementation, "T01-unit.md")]: "## Status\nStatus: DONE\n",
			[path.join(implementation, "T02-unit.md")]:
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
		})
		const runner = new ModeRunner(
			async () => {
				throw new Error("stage creation failed")
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		await expect(
			runner.run(context, state("IMPLEMENTATION", "T01"), {
				type: "schedule_implementation",
				status: "READY_FOR_IMPLEMENTATION",
			}),
		).rejects.toThrow("stage creation failed")

		// The scheduler assignment is the resumable state and is written before Code
		// starts, so it survives a failed launch.
		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: IMPLEMENTATION")
		expect(readme).toContain("Current Task: implementation/T02-unit.md")
	})

	it("does not write READY_FOR_REFACTOR when Refactor cannot be started", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T01-unit.md\n",
			[path.join(implementation, "T01-unit.md")]: "## Status\nStatus: DONE\n",
		})
		const runner = new ModeRunner(
			async () => {
				throw new Error("stage creation failed")
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		await expect(
			runner.run(context, state("IMPLEMENTATION", "T01"), {
				type: "schedule_implementation",
				status: "READY_FOR_IMPLEMENTATION",
			}),
		).rejects.toThrow("stage creation failed")

		expect(fileSystem.files.get(readmePath)).not.toContain("READY_FOR_REFACTOR")
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
		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Current Task: implementation/T02-unit.md")
		// The scheduler owns the pointer when it assigns a unit; the runner must not
		// overwrite it with a status-derived wording.
		expect(readme).toContain("Next Step: Implement T02 (implementation/T02-unit.md).")
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
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: QA_READY\nCurrent Task: NONE\nNext Step: Confirm the QA outcome to finish the task.\nFailure Key: NONE\nFailure Attempts: 0\n",
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

	it("refreshes Next Step on a stop so it no longer describes stale work", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T05-unit.md\nNext Step: Implement T05 (implementation/T05-unit.md).\n",
		})
		const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem)

		await runner.run(context, state("IMPLEMENTATION"), {
			type: "stop",
			status: "QA_READY",
			reason: "pending",
		})

		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: QA_READY")
		expect(readme).toContain("Next Step: Confirm the QA outcome to finish the task.")
		expect(readme).not.toContain("Implement T05")
	})

	it("writes the completion pointer when the lifecycle stops at DONE", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: QA_READY\nCurrent Task: NONE\n",
		})
		const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem)

		await runner.run(context, state("QA_READY"), {
			type: "stop",
			status: "DONE",
			reason: "done",
		})

		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: DONE")
		expect(readme).toContain("Next Step: The lifecycle is complete.")
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
		expect(readme).toContain("Next Step: Review the plan artifacts, then approve the plan.")
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

	it("parks the assigned unit before writing BLOCKED so a resume can assign it again", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T01-unit.md\n",
			[path.join(implementation, "T01-unit.md")]: "## Status\nStatus: IN_PROGRESS\n",
		})
		const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem)

		const result = await runner.run(context, state("IMPLEMENTATION", "T01"), {
			type: "stop",
			status: "BLOCKED",
			reason: "blocked",
		})

		expect(result).toEqual({ type: "stopped", status: "BLOCKED", reason: "blocked" })
		// The unit returns to TODO before the assignment is cleared.
		expect(fileSystem.files.get(path.join(implementation, "T01-unit.md"))).toContain("Status: TODO")
		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: BLOCKED")
		expect(readme).toContain("Current Task: NONE")
		expect(readme).toContain("Next Step: Resolve the blocker, then resume the task.")
	})

	it("writes BLOCKED when the assigned artifact has no Status field to park", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T01-unit.md\n",
			[path.join(implementation, "T01-unit.md")]: "## Goal\n\nNo status field at all.\n",
		})
		const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem)

		const result = await runner.run(context, state("IMPLEMENTATION", "T01"), {
			type: "stop",
			status: "BLOCKED",
			reason: "blocked",
		})

		expect(result).toEqual({ type: "stopped", status: "BLOCKED", reason: "blocked" })
		expect(fileSystem.files.get(readmePath)).toContain("Status: BLOCKED")
		expect(fileSystem.files.get(readmePath)).toContain("Current Task: NONE")
	})

	it("writes BLOCKED when parking the assigned artifact throws", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T01-unit.md\n",
		})
		const logger = new RecordingHarnessLogger()
		const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem, logger)

		const result = await runner.run(context, state("IMPLEMENTATION", "T01"), {
			type: "stop",
			status: "BLOCKED",
			reason: "blocked",
		})

		expect(result).toEqual({ type: "stopped", status: "BLOCKED", reason: "blocked" })
		expect(fileSystem.files.get(readmePath)).toContain("Status: BLOCKED")
		// The failure is diagnosable, but it must never block the status write.
		const failed = logger.byName("harness.lifecycle.park")
		expect(failed).toHaveLength(1)
		expect(failed[0]).toMatchObject({
			kind: "decision",
			level: "warn",
			attributes: { reasonCode: "park-failed" },
		})
	})

	describe("lifecycle transition journal", () => {
		it("journals one mutation for a stop that writes the status", async () => {
			const fileSystem = createInMemoryFileSystem({
				[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: ANALYSIS\nCurrent Task: NONE\n",
			})
			const logger = new RecordingHarnessLogger()
			const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem, logger)

			await runner.run(context, state("ANALYSIS"), {
				type: "stop",
				status: "PLAN_READY",
				reason: "plan-approval",
			})

			const mutations = logger.byName("harness.lifecycle.transition")
			expect(mutations).toHaveLength(1)
			expect(mutations[0]).toMatchObject({
				kind: "mutation",
				target: readmePath,
				stateBefore: { status: "ANALYSIS", currentTask: "NONE" },
				stateAfter: { status: "PLAN_READY", currentTask: "NONE" },
				attributes: { decision: "stop" },
			})
		})

		it("journals one mutation for a start_mode that writes the status", async () => {
			const fileSystem = createInMemoryFileSystem({
				[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: REVIEW\nCurrent Task: NONE\n",
			})
			const logger = new RecordingHarnessLogger()
			const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem, logger)

			await runner.run(context, state("REVIEW"), {
				type: "start_mode",
				status: "REVIEW_PASSED",
				mode: "qa",
			})

			const mutations = logger.byName("harness.lifecycle.transition")
			expect(mutations).toHaveLength(1)
			expect(mutations[0]).toMatchObject({
				stateBefore: { status: "REVIEW" },
				stateAfter: { status: "REVIEW_PASSED" },
				attributes: { decision: "start_mode" },
			})
		})

		it("journals the Refactor transition when the DAG has no ready unit left", async () => {
			const fileSystem = createInMemoryFileSystem({
				[readmePath]:
					"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T01-unit.md\n",
				[path.join(implementation, "T01-unit.md")]: "## Status\nStatus: DONE\n",
			})
			const logger = new RecordingHarnessLogger()
			const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem, logger)

			await runner.run(context, state("IMPLEMENTATION", "T01"), {
				type: "schedule_implementation",
				status: "READY_FOR_IMPLEMENTATION",
			})

			const mutations = logger.byName("harness.lifecycle.transition")
			expect(mutations).toHaveLength(1)
			expect(mutations[0]).toMatchObject({
				stateBefore: { status: "IMPLEMENTATION" },
				stateAfter: { status: "READY_FOR_REFACTOR" },
				attributes: { decision: "schedule_implementation" },
			})
		})

		it("journals the resume transition before the scheduler assigns the next unit", async () => {
			const fileSystem = createInMemoryFileSystem({
				[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: PLAN_READY\nCurrent Task: NONE\n",
				[path.join(implementation, "T01-unit.md")]: "## Status\nStatus: TODO\n",
			})
			const logger = new RecordingHarnessLogger()
			const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem, logger)

			await runner.run(context, state("PLAN_READY"), {
				type: "resume_implementation",
				status: "READY_FOR_IMPLEMENTATION",
			})

			const mutations = logger.byName("harness.lifecycle.transition")
			expect(mutations).toHaveLength(1)
			expect(mutations[0]).toMatchObject({
				stateBefore: { status: "PLAN_READY" },
				stateAfter: { status: "READY_FOR_IMPLEMENTATION" },
				attributes: { decision: "resume_implementation" },
			})
		})

		it("does not journal an idempotent write that changes no field", async () => {
			const fileSystem = createInMemoryFileSystem({
				[readmePath]:
					"Protocol Version: 2\nTask: SITESUP-1116\nStatus: QA_READY\nCurrent Task: NONE\nNext Step: Confirm the QA outcome to finish the task.\nFailure Key: NONE\nFailure Attempts: 0\n",
			})
			const logger = new RecordingHarnessLogger()
			const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem), fileSystem, logger)

			await runner.run(context, state("QA_READY"), {
				type: "stop",
				status: "QA_READY",
				reason: "pending",
			})

			expect(logger.byName("harness.lifecycle.transition")).toHaveLength(0)
		})
	})
})
