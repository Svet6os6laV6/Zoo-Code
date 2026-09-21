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
import * as path from "path"

import type { CanonicalReadmeFields, ReadmeFileSystem } from "../worktree/task-readme.js"
import {
	CanonicalReadmeError,
	CanonicalReadmeWriter,
	clearedFailureFields,
	NO_CURRENT_TASK,
	NO_FAILURE_KEY,
	readCanonicalFields,
	readmePath,
} from "../worktree/task-readme.js"
import type { TaskContext } from "../worktree/task-resolver.js"
import type { TaskState, TaskStatus } from "../worktree/task-state.js"
import { TaskScheduler } from "../worktree/task-scheduler.js"
import { parkImplementationTask } from "../worktree/txx-status-writer.js"

import {
	LifecycleError,
	type FailureTracking,
	type LifecycleMode,
	type LifecycleResult,
	type ModeRunResult,
} from "./lifecycle-types.js"
import { buildStageInstruction } from "./stage-instructions.js"

type StartMode = (mode: LifecycleMode, message: string) => Promise<void>

/**
 * The assigned unit as a task-relative path, or `null` when no unit is assigned.
 *
 * Task-relative (not workspace-relative) keeps the instruction independent of the
 * process cwd: the child task receives the same pointer wherever it runs.
 */
function assignedArtifact(context: TaskContext, state: TaskState): string | null {
	if (!state.currentTaskArtifact) {
		return null
	}

	return path.relative(context.taskRoot, state.currentTaskArtifact).split(path.sep).join("/")
}

export class ModeRunner {
	private readonly readme: CanonicalReadmeWriter
	private readonly fileSystem: ReadmeFileSystem

	constructor(
		private readonly startMode: StartMode,
		private readonly scheduler: Pick<TaskScheduler, "assignNext" | "plan"> = new TaskScheduler(),
		fileSystem: ReadmeFileSystem = fs,
	) {
		this.fileSystem = fileSystem
		this.readme = new CanonicalReadmeWriter(fileSystem)
	}

	async run(context: TaskContext, state: TaskState, decision: LifecycleResult): Promise<ModeRunResult> {
		switch (decision.type) {
			case "invalid":
				return decision

			case "stop":
				await this.writeState(context, decision.status, decision.failure)
				return { type: "stopped", status: decision.status, reason: decision.reason }

			case "start_mode":
				await this.writeState(context, decision.status, decision.failure)
				await this.startMode(
					decision.mode,
					buildStageInstruction({
						mode: decision.mode,
						taskId: context.taskId,
						assignedArtifact: assignedArtifact(context, state),
						failure: decision.failure,
					}),
				)
				return { type: "started", mode: decision.mode, status: decision.status }

			case "schedule_implementation": {
				const assignment = await this.scheduler.assignNext(context, { ...state, status: decision.status })
				if (assignment) {
					return this.startCode(context, assignment.relativeArtifact)
				}

				return this.startRefactorOrInvalid(context)
			}

			case "reschedule_implementation":
			case "resume_implementation": {
				// Two ways the task returns to the implementation queue with the DAG
				// recomputed: a unit that discovered an internal dependency (park it so
				// it becomes ready again once the dependency completes), and a task
				// resumed from `BLOCKED` after the harness confirmed the Unblock
				// Condition. Nothing is assigned while blocked, so the park and the
				// reschedule loop guard are no-ops on resume.
				if (state.currentTaskArtifact) {
					await parkImplementationTask(this.fileSystem, state.currentTaskArtifact)
				}

				// Clear the assignment. `READY_FOR_IMPLEMENTATION` + `Current Task: NONE`
				// is a canonical, resumable state, so even a failure below leaves the
				// task recoverable instead of stuck at BLOCKED.
				await this.writeState(context, decision.status)

				const plan = await this.scheduler.plan(context)

				// Guard against a spurious reschedule: if the parked unit is still
				// ready, no real dependency was added and reassigning it would loop.
				if (state.currentTask && plan.ready.some((task) => task.id === state.currentTask)) {
					return {
						type: "invalid",
						reason: `Reschedule left ${state.currentTask} ready; no dependency was added`,
					}
				}

				const assignment = await this.scheduler.assignNext(
					context,
					{ ...state, status: decision.status, currentTask: null, currentTaskArtifact: null },
					plan.artifacts,
				)
				if (assignment) {
					return this.startCode(context, assignment.relativeArtifact)
				}

				return this.startRefactorOrInvalid(context)
			}

			default:
				return this.assertNever(decision)
		}
	}

	/** Start Code on an assigned unit and report the started stage. */
	private async startCode(context: TaskContext, assignedArtifact: string): Promise<ModeRunResult> {
		await this.startMode("code", buildStageInstruction({ mode: "code", taskId: context.taskId, assignedArtifact }))
		return { type: "started", mode: "code", status: "IMPLEMENTATION" }
	}

	/**
	 * The DAG has no ready unit left: start Refactor when every unit is done,
	 * otherwise report `invalid` so the caller falls back to the legacy resume.
	 */
	private async startRefactorOrInvalid(context: TaskContext): Promise<ModeRunResult> {
		const plan = await this.scheduler.plan(context)
		if (plan.artifacts.tasks.length > 0 && plan.done.length === plan.artifacts.tasks.length) {
			await this.writeState(context, "READY_FOR_REFACTOR")
			await this.startMode(
				"refactor",
				buildStageInstruction({ mode: "refactor", taskId: context.taskId, assignedArtifact: null }),
			)
			return { type: "started", mode: "refactor", status: "READY_FOR_REFACTOR" }
		}

		return { type: "invalid", reason: "TaskScheduler found no ready implementation unit" }
	}

	/**
	 * Persist the canonical status, clear the assigned unit, and reconcile the
	 * failure-tracking block.
	 *
	 * Only the fields that actually change are written, so an idempotent marker
	 * (`QA_READY` reported twice) rewrites identical bytes and is skipped. The
	 * failure block is updated when a decision carries tracking and cleared
	 * otherwise, which keeps the README pointing at the finding currently being
	 * remediated — or at nothing when the loop has ended.
	 */
	private async writeState(context: TaskContext, status: TaskStatus, failure?: FailureTracking): Promise<void> {
		const readme = await this.fileSystem.readFile(readmePath(context.taskRoot), "utf8")
		const current = readCanonicalFields(readme)
		const fields: CanonicalReadmeFields = {}

		if (current.status !== status) {
			fields.Status = status
		}
		if (current.currentTask !== NO_CURRENT_TASK) {
			fields["Current Task"] = NO_CURRENT_TASK
		}

		if (failure && (failure.key !== null || failure.attempts > 0)) {
			const key = failure.key ?? NO_FAILURE_KEY
			const attempts = String(failure.attempts)
			if (current.failureKey !== key) {
				fields["Failure Key"] = key
			}
			if (current.failureAttempts !== attempts) {
				fields["Failure Attempts"] = attempts
			}
		} else {
			// Clearing also completes a protocol v2 block that never had the failure
			// fields, but only when a field actually changes: an already-canonical
			// README stays byte-identical, so an idempotent marker is still a no-op.
			const cleared = clearedFailureFields()
			if (current.failureKey !== cleared["Failure Key"]) {
				fields["Failure Key"] = cleared["Failure Key"]
			}
			if (current.failureAttempts !== cleared["Failure Attempts"]) {
				fields["Failure Attempts"] = cleared["Failure Attempts"]
			}
		}

		if (Object.keys(fields).length === 0) {
			return
		}

		try {
			await this.readme.update(context.taskRoot, fields)
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
