/**
 * ModeRunner
 *
 * The effectful half of the lifecycle: it applies a decision produced by
 * `LifecycleController`. It owns three things and nothing else:
 *
 * 1. starting the mode the controller selected — the model is never asked to pick
 *    its own next stage,
 * 2. the canonical README status write (through the shared block writer, so the
 *    scheduler and the lifecycle never fight over the same file format),
 * 3. asking `TaskScheduler` for the next implementation unit when a decision
 *    continues the DAG.
 *
 * Ordering matters: a stage is started *before* the canonical status is written,
 * so a stage that cannot be created leaves the README at its previous state
 * instead of claiming a stage that never ran. The one exception is the
 * implementation assignment, which is the resumable state the scheduler writes
 * before Code starts.
 *
 * Every failure surfaces as a `LifecycleError` or an `invalid` result; the caller
 * decides whether to fall back to its previous resume path.
 */

import { promises as fs } from "fs"
import * as path from "path"

import { harnessLogger } from "../observability/harness-logger.js"
import type { HarnessLoggerPort } from "../observability/types.js"
import type { CanonicalReadmeFields, CanonicalReadmeUpdate, ReadmeFileSystem } from "../worktree/task-readme.js"
import {
	CanonicalReadmeError,
	CanonicalReadmeWriter,
	clearedFailureFields,
	NO_BLOCKED_FROM,
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
 * Why a canonical status write happened, carried into the mutation record.
 *
 * `decision` is the `LifecycleResult` variant that produced the write and
 * `reason` the human-readable cause, so a log reader can reconstruct "why did
 * the status change" without replaying the controller.
 */
type TransitionJournal = {
	readonly decision: LifecycleResult["type"]
	readonly reason: string
}

/**
 * The canonical fields one status write may touch.
 *
 * Grouped instead of passed positionally: `failure` and `journal` are optional,
 * so a positional call would need `undefined` placeholders to reach `nextStep`.
 * An omitted `nextStep` means "leave the pointer alone" — the scheduler owns it
 * when it assigns an implementation unit. `blockedFrom` is present only on the
 * `BLOCKED` stop that records it; every other write clears a stale origin.
 */
type CanonicalStateWrite = {
	readonly status: TaskStatus
	readonly failure?: FailureTracking
	readonly journal?: TransitionJournal
	readonly nextStep?: string
	readonly blockedFrom?: TaskStatus
}

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

/**
 * The human-readable `Next Step` pointer for a status the runner writes.
 *
 * Status-derived and deterministic: the field is a human-facing pointer, so the
 * wording follows the status semantics rather than the decision that produced it.
 * `undefined` means "leave the field alone" — the scheduler owns the pointer when
 * it assigns an implementation unit, and the runner must not overwrite it.
 */
function nextStepForStatus(status: TaskStatus): string | undefined {
	switch (status) {
		case "PLAN_READY":
			return "Review the plan artifacts, then approve the plan."
		case "QA_READY":
			return "Confirm the QA outcome to finish the task."
		case "BLOCKED":
			return "Resolve the blocker, then resume the task."
		case "DONE":
			return "The lifecycle is complete."
		case "READY_FOR_REFACTOR":
			return "Run the refactor stage."
		default:
			return undefined
	}
}

export class ModeRunner {
	private readonly readme: CanonicalReadmeWriter
	private readonly fileSystem: ReadmeFileSystem

	constructor(
		private readonly startMode: StartMode,
		private readonly scheduler: Pick<TaskScheduler, "assignNext" | "plan"> = new TaskScheduler(),
		fileSystem: ReadmeFileSystem = fs,
		/** Explicit injection for tests; defaults to the process-wide harness logger. */
		private readonly logger?: HarnessLoggerPort,
	) {
		this.fileSystem = fileSystem
		this.readme = new CanonicalReadmeWriter(fileSystem)
	}

	async run(context: TaskContext, state: TaskState, decision: LifecycleResult): Promise<ModeRunResult> {
		switch (decision.type) {
			case "invalid":
				return decision

			case "stop":
				// A stop at `BLOCKED` parks the assigned unit *before* the write clears
				// `Current Task`. Without the park the scheduler would later find the
				// artifact still `IN_PROGRESS` with no assignment and skip it as
				// `current-unit-unfinished`, so a confirmed resume could never hand the
				// work back.
				if (decision.status === "BLOCKED" && state.currentTaskArtifact) {
					await this.parkAssignedUnit(context, state.currentTaskArtifact)
				}

				await this.writeState(context, {
					status: decision.status,
					failure: decision.failure,
					journal: { decision: decision.type, reason: decision.reason },
					nextStep: nextStepForStatus(decision.status),
					blockedFrom: decision.blockedFrom,
				})
				return { type: "stopped", status: decision.status, reason: decision.reason }

			case "start_mode": {
				// A decision that carries failure tracking is either a Code fix pass
				// or a re-verification by the requesting stage; the pointer names
				// which, so a human reading the README can tell a fix pass from an
				// ordinary stage run (the `QA_READY` marker alone does not).
				const finding = decision.failure?.key ?? "an unnamed finding"
				const attempts = decision.failure?.attempts
				const fixInFlight = decision.failure !== undefined && (attempts ?? 0) > 0
				const nextStep =
					fixInFlight && decision.mode === "code"
						? `Run the code fix pass for ${finding} (attempt ${attempts}).`
						: fixInFlight
							? `Re-run the ${decision.mode} stage to verify the fix for ${finding}.`
							: `Run the ${decision.mode} stage.`

				// Start the stage before advancing the canonical state: a stage that
				// cannot be created must not leave the README claiming a stage that never
				// ran (the reported `REVIEW_PASSED` without a QA phase). The write then
				// happens after the stage is running, so a write failure is logged and
				// rethrown instead of rolled back.
				await this.startMode(
					decision.mode,
					buildStageInstruction({
						mode: decision.mode,
						taskId: context.taskId,
						assignedArtifact: assignedArtifact(context, state),
						failure: decision.failure,
					}),
				)
				await this.writeStateAfterStart(context, {
					status: decision.status,
					failure: decision.failure,
					journal: {
						decision: decision.type,
						reason: fixInFlight
							? `started the ${decision.mode} fix pass`
							: `started the ${decision.mode} stage`,
					},
					nextStep,
				})
				return { type: "started", mode: decision.mode, status: decision.status }
			}

			case "schedule_implementation": {
				const assignment = await this.scheduler.assignNext(context, { ...state, status: decision.status })
				if (assignment) {
					return this.startCode(context, assignment.relativeArtifact)
				}

				return this.startRefactorOrInvalid(context, decision.type)
			}

			case "reschedule_implementation":
			case "resume_implementation": {
				// Two ways the task returns to the implementation queue with the DAG
				// recomputed: a unit that discovered an internal dependency (park it so
				// it becomes ready again once the dependency completes), and a task
				// resumed from `BLOCKED` after the harness confirmed the Unblock
				// Condition. Nothing is assigned while blocked — the `stop` that wrote
				// `BLOCKED` already parked the assigned unit — so the park below and the
				// reschedule loop guard are no-ops on resume.
				if (state.currentTaskArtifact) {
					await parkImplementationTask(this.fileSystem, state.currentTaskArtifact, this.logger)
				}

				// Clear the assignment. `READY_FOR_IMPLEMENTATION` + `Current Task: NONE`
				// is a canonical, resumable state, so even a failure below leaves the
				// task recoverable instead of stuck at BLOCKED.
				await this.writeState(context, {
					status: decision.status,
					journal: {
						decision: decision.type,
						reason:
							decision.type === "reschedule_implementation"
								? "parked the assigned unit and recomputed the DAG"
								: "resumed the task and recomputed the DAG",
					},
				})

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

				return this.startRefactorOrInvalid(context, decision.type)
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
	private async startRefactorOrInvalid(
		context: TaskContext,
		decision: LifecycleResult["type"],
	): Promise<ModeRunResult> {
		const plan = await this.scheduler.plan(context)
		if (plan.artifacts.tasks.length > 0 && plan.done.length === plan.artifacts.tasks.length) {
			// Same ordering as `start_mode`: start Refactor first, then advance the
			// canonical state, so a stage that cannot be created leaves the README
			// unchanged.
			await this.startMode(
				"refactor",
				buildStageInstruction({ mode: "refactor", taskId: context.taskId, assignedArtifact: null }),
			)
			await this.writeStateAfterStart(context, {
				status: "READY_FOR_REFACTOR",
				journal: { decision, reason: "every implementation unit is done; starting Refactor" },
				nextStep: nextStepForStatus("READY_FOR_REFACTOR"),
			})
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
	 *
	 * Callers that start a stage must use `writeStateAfterStart` instead, so a
	 * write failure after the stage is already running is logged and rethrown
	 * rather than silently swallowed.
	 */
	private async writeState(context: TaskContext, write: CanonicalStateWrite): Promise<void> {
		const { status, failure, journal, nextStep, blockedFrom } = write
		const readme = await this.fileSystem.readFile(readmePath(context.taskRoot), "utf8")
		const current = readCanonicalFields(readme)
		const fields: CanonicalReadmeFields = {}

		if (current.status !== status) {
			fields.Status = status
		}
		if (current.currentTask !== NO_CURRENT_TASK) {
			fields["Current Task"] = NO_CURRENT_TASK
		}
		// `undefined` leaves the field alone: the scheduler owns the pointer when it
		// assigns an implementation unit, and the runner must not overwrite it.
		if (nextStep !== undefined && current.nextStep !== nextStep) {
			fields["Next Step"] = nextStep
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
			const total = String(failure.total)
			if (current.totalFailureAttempts !== total) {
				fields["Total Failure Attempts"] = total
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
			if (current.totalFailureAttempts !== cleared["Total Failure Attempts"]) {
				fields["Total Failure Attempts"] = cleared["Total Failure Attempts"]
			}
		}

		// The `Blocked From` origin is recorded by the `BLOCKED` stop and cleared by
		// every other write, so a future block can never resume to a stale origin.
		if (status === "BLOCKED" && blockedFrom) {
			if (current.blockedFrom !== blockedFrom) {
				fields["Blocked From"] = blockedFrom
			}
		} else if (current.blockedFrom !== null && current.blockedFrom !== NO_BLOCKED_FROM) {
			fields["Blocked From"] = NO_BLOCKED_FROM
		}

		if (Object.keys(fields).length === 0) {
			return
		}

		let update: CanonicalReadmeUpdate
		try {
			update = await this.readme.update(context.taskRoot, fields)
		} catch (error) {
			if (error instanceof CanonicalReadmeError) {
				throw new LifecycleError(error.message)
			}
			throw error
		}

		if (journal) {
			this.journalTransition(context, update, journal)
		}
	}

	/**
	 * Persist the canonical status after the stage has already started.
	 *
	 * The stage is running, so a filesystem failure here must not be swallowed:
	 * it is logged and rethrown. Rolling the stage back is not an option (the
	 * child task is already delegated), and "continue lifecycle" reconciles the
	 * README from the canonical state on the next run.
	 */
	private async writeStateAfterStart(context: TaskContext, write: CanonicalStateWrite): Promise<void> {
		try {
			await this.writeState(context, write)
		} catch (error) {
			this.logBestEffort(() =>
				harnessLogger(this.logger).decision("harness.lifecycle.write-after-start", {
					level: "error",
					input: { status: write.status },
					result: null,
					reason: "the stage started but the canonical status write failed; the README is stale until the next continue",
					attributes: {
						reasonCode: "write-after-start-failed",
						error: error instanceof Error ? error.message : String(error),
					},
					context: { taskId: context.taskId },
				}),
			)
			throw error
		}
	}

	/**
	 * Park the assigned implementation unit before a `BLOCKED` write clears the
	 * assignment.
	 *
	 * Best-effort, like the transition journal: the durable record of *why* the
	 * task stopped matters more than the park, so a park that cannot run (the
	 * artifact vanished, its status field cannot be rewritten) is logged and
	 * swallowed instead of aborting the status write. An `unchanged` result is not a
	 * failure either — the unit was not `IN_PROGRESS`, so there is nothing to
	 * requeue and the BLOCKED status still proceeds.
	 */
	private async parkAssignedUnit(context: TaskContext, artifactPath: string): Promise<void> {
		try {
			await parkImplementationTask(this.fileSystem, artifactPath, this.logger)
		} catch (error) {
			this.logBestEffort(() =>
				harnessLogger(this.logger).decision("harness.lifecycle.park", {
					level: "warn",
					input: { artifactPath },
					result: null,
					reason: "could not park the assigned implementation unit before writing BLOCKED; writing the status anyway",
					attributes: {
						reasonCode: "park-failed",
						error: error instanceof Error ? error.message : String(error),
					},
					context: { taskId: context.taskId },
				}),
			)
		}
	}

	/**
	 * Record the canonical status write as a mutation.
	 *
	 * `stateBefore`/`stateAfter` come from the writer's own read-modify-write, so
	 * they describe one filesystem moment instead of two independent reads. The
	 * record is best-effort: a logger failure must never undo a status write that
	 * already succeeded, so it is swallowed exactly like `reportArtifactChanges`.
	 */
	private journalTransition(context: TaskContext, update: CanonicalReadmeUpdate, journal: TransitionJournal): void {
		this.logBestEffort(() =>
			harnessLogger(this.logger).mutation("harness.lifecycle.transition", {
				target: update.filePath,
				stateBefore: update.before,
				stateAfter: update.after,
				reason: journal.reason,
				attributes: { decision: journal.decision },
				context: { taskId: context.taskId },
			}),
		)
	}

	/**
	 * Emit a diagnostic record without letting the diagnostic change the outcome
	 * it observes: a logger failure must never undo a state change that already
	 * happened.
	 */
	private logBestEffort(record: () => void): void {
		try {
			record()
		} catch {
			// Diagnostics only; the caller's state change stands.
		}
	}

	private assertNever(value: never): never {
		throw new LifecycleError(`Unhandled lifecycle decision: ${JSON.stringify(value)}`)
	}
}
