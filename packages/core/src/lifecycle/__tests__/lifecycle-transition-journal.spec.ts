import * as path from "path"

import { HarnessLogger } from "../../observability/harness-logger.js"
import type { HarnessLogRecord, HarnessLogSink } from "../../observability/types.js"
import type { TaskContext } from "../../worktree/task-resolver.js"
import type { TaskState } from "../../worktree/task-state.js"
import { TaskScheduler } from "../../worktree/task-scheduler.js"
import { createInMemoryFileSystem } from "../../worktree/__tests__/helpers/in-memory-fs.js"
import { LifecycleController, ModeRunner } from "../index.js"

const taskRoot = path.join("/workspace", ".roo", "tasks", "SITESUP-1116")
const readmePath = path.join(taskRoot, "README.md")
const implementation = path.join(taskRoot, "implementation")
const context: TaskContext = { taskId: "SITESUP-1116", branch: "feature/SITESUP-1116", taskRoot }

function recordingSink(): HarnessLogSink & { records: HarnessLogRecord[] } {
	const records: HarnessLogRecord[] = []

	return {
		name: "recording",
		records,
		write: (record) => {
			records.push(record)
		},
	}
}

function state(status: TaskState["status"], currentTask: string | null = null): TaskState {
	return {
		taskId: context.taskId,
		status,
		currentTask,
		currentTaskArtifact: currentTask ? path.join(implementation, `${currentTask}-unit.md`) : null,
		failureKey: null,
		failureAttempts: 0,
	}
}

function readmeStatus(fileSystem: ReturnType<typeof createInMemoryFileSystem>): string | null {
	const readme = fileSystem.files.get(readmePath) ?? ""
	return readme.match(/^Status:\s*(.*)$/m)?.[1]?.trim() ?? null
}

/**
 * Contract D: every canonical `Status` change leaves a mutation record.
 *
 * The fixture walks the incident path — `ANALYSIS` → `PLAN_READY` → (approve) →
 * `IMPLEMENTATION` → `READY_FOR_REFACTOR` — and asserts that each observed status
 * change is covered by a mutation record whose `stateAfter` carries the new
 * status. A real `HarnessLogger` with a recording sink is used so the per-call
 * `context.taskId` is captured, which the recording double does not model.
 */
describe("lifecycle transition journal", () => {
	it("leaves a mutation record for every Status change across the lifecycle", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: ANALYSIS\nCurrent Task: NONE\n",
			[path.join(taskRoot, "implementation-plan.md")]: "# Plan\n",
			[path.join(implementation, "T01-unit.md")]: "## Status\nStatus: TODO\n",
		})
		const sink = recordingSink()
		const logger = new HarnessLogger({ sinks: [sink] })
		const controller = new LifecycleController()
		// The scheduler shares the logger so its assignment mutation is captured too:
		// the `IMPLEMENTATION` status change is written by the scheduler, not the runner.
		const runner = new ModeRunner(vi.fn(), new TaskScheduler(fileSystem, undefined, logger), fileSystem, logger)

		const statuses: (string | null)[] = [readmeStatus(fileSystem)]

		// ANALYSIS -> PLAN_READY: the Architect completed and the approval gate is on.
		await runner.run(
			context,
			state("ANALYSIS"),
			controller.transition(
				state("ANALYSIS"),
				{ mode: "architect", result: "COMPLETED", failureKey: null },
				{ requirePlanApproval: true },
			),
		)
		statuses.push(readmeStatus(fileSystem))

		// PLAN_READY -> IMPLEMENTATION: the plan is approved and the first unit is assigned.
		await runner.run(context, state("PLAN_READY"), controller.approvePlan(state("PLAN_READY")))
		statuses.push(readmeStatus(fileSystem))

		// IMPLEMENTATION -> READY_FOR_REFACTOR: the only unit is done.
		fileSystem.files.set(path.join(implementation, "T01-unit.md"), "## Status\nStatus: DONE\n")
		await runner.run(
			context,
			state("IMPLEMENTATION", "T01"),
			controller.transition(state("IMPLEMENTATION", "T01"), {
				mode: "code",
				result: "COMPLETED",
				failureKey: null,
			}),
		)
		statuses.push(readmeStatus(fileSystem))

		expect(statuses).toEqual(["ANALYSIS", "PLAN_READY", "IMPLEMENTATION", "READY_FOR_REFACTOR"])

		const mutations = sink.records.filter((record) => record.kind === "mutation")
		for (let index = 1; index < statuses.length; index += 1) {
			const next = statuses[index]
			const covering = mutations.filter(
				(record) => (record.stateAfter as { status?: string } | undefined)?.status === next,
			)
			expect(covering.length).toBeGreaterThan(0)
		}

		// The lifecycle-owned writes carry the task context so the records land in
		// the right trace.
		const transitions = sink.records.filter((record) => record.name === "harness.lifecycle.transition")
		expect(transitions.length).toBeGreaterThanOrEqual(3)
		expect(transitions.every((record) => record.context.taskId === "SITESUP-1116")).toBe(true)
	})
})
