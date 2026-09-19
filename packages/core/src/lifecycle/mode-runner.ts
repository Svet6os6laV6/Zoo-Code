/**
 * ModeRunner
 *
 * The effectful half of the lifecycle: it applies a decision produced by
 * `LifecycleController`. It owns three things and nothing else:
 *
 * 1. the canonical README status write (through the shared block writer, so the
 *    scheduler and the lifecycle never fight over the same file format),
 * 2. asking `TaskScheduler` for the next implementation unit when a decision
 *    continues the DAG,
 * 3. starting the mode the controller selected — the model is never asked to pick
 *    its own next stage.
 *
 * Every failure surfaces as a `LifecycleError` or an `invalid` result; the caller
 * decides whether to fall back to its previous resume path.
 */

import { promises as fs } from "fs"

import type { ReadmeFileSystem } from "../worktree/task-readme.js"
import { CanonicalReadmeError, CanonicalReadmeWriter, NO_CURRENT_TASK } from "../worktree/task-readme.js"
import type { TaskContext } from "../worktree/task-resolver.js"
import type { TaskState, TaskStatus } from "../worktree/task-state.js"
import { TaskScheduler } from "../worktree/task-scheduler.js"

import {
	LifecycleError,
	STAGE_RESULT_MARKER,
	type LifecycleMode,
	type LifecycleResult,
	type ModeRunResult,
} from "./lifecycle-types.js"

type StartMode = (mode: LifecycleMode, message: string) => Promise<void>

/**
 * The stage instruction. The marker it asks the stage to report is the same
 * constant `parseStageOutcome` matches on, so the prompt and the parser stay in
 * lockstep.
 */
function modeMessage(mode: LifecycleMode, taskId: string): string {
	return `Run the ${mode} stage for ${taskId}. Report the semantic outcome as one '${STAGE_RESULT_MARKER} <RESULT>' line. Do not select the next mode or lifecycle status.`
}

export class ModeRunner {
	private readonly readme: CanonicalReadmeWriter

	constructor(
		private readonly startMode: StartMode,
		private readonly scheduler: Pick<TaskScheduler, "assignNext" | "plan"> = new TaskScheduler(),
		fileSystem: ReadmeFileSystem = fs,
	) {
		this.readme = new CanonicalReadmeWriter(fileSystem)
	}

	async run(context: TaskContext, state: TaskState, decision: LifecycleResult): Promise<ModeRunResult> {
		switch (decision.type) {
			case "invalid":
				return decision

			case "stop":
				await this.writeState(context, state, decision.status)
				return { type: "stopped", status: decision.status, reason: decision.reason }

			case "start_mode":
				await this.writeState(context, state, decision.status)
				await this.startMode(decision.mode, modeMessage(decision.mode, context.taskId))
				return { type: "started", mode: decision.mode, status: decision.status }

			case "schedule_implementation": {
				const assignment = await this.scheduler.assignNext(context, { ...state, status: decision.status })
				if (assignment) {
					await this.startMode("code", modeMessage("code", context.taskId))
					return { type: "started", mode: "code", status: "IMPLEMENTATION" }
				}

				const plan = await this.scheduler.plan(context)
				if (plan.artifacts.tasks.length > 0 && plan.done.length === plan.artifacts.tasks.length) {
					await this.writeState(context, state, "READY_FOR_REFACTOR")
					await this.startMode("refactor", modeMessage("refactor", context.taskId))
					return { type: "started", mode: "refactor", status: "READY_FOR_REFACTOR" }
				}

				return { type: "invalid", reason: "TaskScheduler found no ready implementation unit" }
			}

			default:
				return this.assertNever(decision)
		}
	}

	/**
	 * Persist the canonical status and clear the assigned unit.
	 *
	 * A marker that is already canonical with no unit assigned would be rewritten
	 * to identical bytes, so it is skipped: idempotent stages (`QA_READY` reported
	 * twice) stay legal without self-loop transitions in the status machine.
	 */
	private async writeState(context: TaskContext, state: TaskState, status: TaskStatus): Promise<void> {
		if (state.status === status && state.currentTask === null) {
			return
		}

		try {
			await this.readme.update(context.taskRoot, { Status: status, "Current Task": NO_CURRENT_TASK })
		} catch (error) {
			if (error instanceof CanonicalReadmeError) {
				throw new LifecycleError(error.message)
			}
			throw error
		}
	}

	private assertNever(value: never): never {
		throw new LifecycleError(`Unhandled lifecycle decision: ${JSON.stringify(value)}`)
	}
}
