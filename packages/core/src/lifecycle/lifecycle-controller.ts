import { isTaskStatusTransition, type TaskState, type TaskStatus } from "../worktree/task-state.js"

import {
	LifecycleError,
	type FailureTracking,
	type LifecycleMode,
	type LifecycleResolveInput,
	type LifecycleResult,
	type StageOutcome,
	type StageResult,
} from "./lifecycle-types.js"

/**
 * Which lifecycle status each stage is allowed to *complete*.
 *
 * This is the precondition half of the model: an outcome is only trusted when the
 * mode that reported it owns the status the README is currently in. The
 * transition half lives in the canonical status machine
 * (`TASK_STATUS_TRANSITIONS`), which every written status is validated against in
 * `transition()` — so a stage rule and the canonical README model cannot drift
 * apart unnoticed.
 *
 * `code` lists the remediation markers as well as `IMPLEMENTATION`: a failing
 * stage hands the fix to Code without leaving its own stage, so Code completes
 * from `REFACTOR`, `REVIEW`, or `QA_READY` too (see `reverifyRequestingStage`).
 */
export const MODE_STATUSES = {
	sublimation: ["ANALYSIS"],
	code: ["IMPLEMENTATION", "REFACTOR", "REVIEW", "QA_READY"],
	refactor: ["READY_FOR_REFACTOR", "REFACTOR"],
	reviewer: ["READY_FOR_REVIEW", "REVIEW"],
	qa: ["REVIEW_PASSED", "QA_READY"],
} as const satisfies Record<LifecycleMode, readonly TaskStatus[]>

/**
 * Maximum number of fix passes the harness starts for a single failure key before
 * it stops the loop and hands the task back to the user as `BLOCKED`.
 *
 * Deliberately a code constant, not a prompt instruction: the bound must hold even
 * when the model keeps proposing the same remedy.
 */
export const MAX_FAILURE_ATTEMPTS = 3

/**
 * Maximum number of fix passes the harness starts in one remediation episode,
 * across every failure key.
 *
 * The per-key budget bounds a loop that keeps naming the same finding; this
 * budget bounds the loop that keeps renaming it. Each fresh key resets the
 * per-key counter but still advances this one, so the episode cannot spin by
 * relabelling the same finding. Like the per-key budget, it is cleared by every
 * decision that advances the lifecycle, so it bounds one remediation episode
 * and not the whole task history.
 */
export const MAX_TOTAL_FAILURE_ATTEMPTS = 6

function invalid(reason: string): LifecycleResult {
	return { type: "invalid", reason }
}

/**
 * Attribute a fix pass to a failure key and decide whether it may still run.
 *
 * The key is carried over from the README when the stage did not name one, so an
 * unnamed loop is bounded by the same counter. A different key starts a fresh
 * per-key count; the same key advances it. The total counter advances on every
 * pass regardless of key, so relabelling the same finding cannot reset the
 * episode budget. When either budget would be exceeded the loop stops instead of
 * running another attempt.
 */
function startFixPass(
	state: TaskState,
	outcome: StageOutcome,
	decision: { readonly type: "start_mode"; readonly status: TaskStatus; readonly mode: LifecycleMode },
): LifecycleResult {
	const key = outcome.failureKey ?? state.failureKey
	const attempts = state.failureKey === key ? state.failureAttempts + 1 : 1
	const total = state.totalFailureAttempts + 1

	if (attempts > MAX_FAILURE_ATTEMPTS) {
		return {
			type: "stop",
			status: "BLOCKED",
			reason: "max-attempts",
			failure: { key, attempts: MAX_FAILURE_ATTEMPTS, total },
			blockedFrom: state.status,
		}
	}

	if (total > MAX_TOTAL_FAILURE_ATTEMPTS) {
		return {
			type: "stop",
			status: "BLOCKED",
			reason: "max-total-attempts",
			failure: { key, attempts, total: MAX_TOTAL_FAILURE_ATTEMPTS },
			blockedFrom: state.status,
		}
	}

	return { ...decision, failure: { key, attempts, total } }
}

function unsupported(mode: StageOutcome["mode"], result: StageResult): LifecycleResult {
	return invalid(`Stage result ${result} is not supported for mode ${mode}`)
}

function assertNever(value: never): never {
	throw new LifecycleError(`Unhandled lifecycle variant: ${JSON.stringify(value)}`)
}

/**
 * Route a completed remediation pass back to the stage that requested the fix.
 *
 * The status stays on the requesting stage's marker while Code runs, so the fix
 * pass inherits that stage's context (an unassigned unit, the stage's report) and
 * never re-enters the implementation DAG. When the fix reports success the stage
 * re-verifies it through its own entry status.
 */
function reverifyRequestingStage(status: TaskStatus, failure: FailureTracking): LifecycleResult {
	switch (status) {
		// The failure tracking is preserved across the re-verification so that a
		// finding that comes back is counted against the same budget instead of
		// restarting the loop with a fresh counter.
		case "REFACTOR":
			return { type: "start_mode", status: "READY_FOR_REFACTOR", mode: "refactor", failure }
		case "REVIEW":
			return { type: "start_mode", status: "READY_FOR_REVIEW", mode: "reviewer", failure }
		case "QA_READY":
			return { type: "start_mode", status: "REVIEW_PASSED", mode: "qa", failure }
		default:
			return invalid(`Code completion cannot be routed from lifecycle status ${status}`)
	}
}

export class LifecycleController {
	/**
	 * Decide what happens after a stage reported `outcome` while the task README
	 * carries `state`.
	 *
	 * Pure: the caller is responsible for the effects (`ModeRunner`), which keeps
	 * the whole routing model exhaustively testable. The returned status is the one
	 * the harness will write — it is validated against the canonical status machine
	 * here, so nothing outside this table is ever persisted.
	 */
	transition(
		state: TaskState,
		outcome: StageOutcome,
		options: { readonly requirePlanApproval?: boolean } = {},
	): LifecycleResult {
		if (!MODE_STATUSES[outcome.mode].some((status) => status === state.status)) {
			return invalid(`Mode ${outcome.mode} cannot complete lifecycle status ${state.status}`)
		}

		// The approval gate is an explicit input, not a setting the controller reads:
		// packages/core stays pure and the integration owns the user preference. Only
		// the Sublimation stage consults it; every other mode ignores the option.
		const decision = this.decide(state, outcome, options.requirePlanApproval ?? true)

		// Only statuses the harness writes itself are validated here.
		// `schedule_implementation` defers the write to TaskScheduler, which owns its
		// own preconditions and re-derives the canonical status from the DAG.
		if (decision.type === "invalid" || decision.type === "schedule_implementation") {
			return decision
		}

		// Re-writing the current status is a no-op, not a transition: `ModeRunner`
		// skips the write, which keeps idempotent markers such as `QA_READY` legal
		// without inventing self-loop edges in the canonical table.
		if (decision.status !== state.status && !isTaskStatusTransition(state.status, decision.status)) {
			return invalid(
				`Status transition ${state.status} -> ${decision.status} is not a canonical task status transition`,
			)
		}

		return decision
	}

	/**
	 * Resume a task stopped at `BLOCKED`.
	 *
	 * `BLOCKED` is not routable from a stage outcome, so the harness owns this
	 * action. The caller has already confirmed the `Unblock Condition` (a user
	 * signal or a verified external event), which is why the confirmation is an
	 * explicit argument the controller cannot observe itself.
	 *
	 * The task returns to the status it held before blocking — recorded as
	 * `Blocked From` when the stop wrote it — so a block taken during review or
	 * QA resumes into that stage instead of re-running the implementation
	 * pipeline that already passed. A legacy record with no origin falls back to
	 * the historical behavior: the implementation queue. A fix pass that was in
	 * flight resumes as a re-verification by the requesting stage (its marker
	 * status maps to the stage's entry status), preserving the failure budget so
	 * a finding that comes back is counted against the same episode.
	 *
	 * Pure and side-effect free, like `transition`; `ModeRunner` applies the result.
	 */
	resume(state: TaskState, unblockConditionMet: boolean): LifecycleResult {
		if (state.status !== "BLOCKED") {
			return invalid(`Resume is only valid from BLOCKED, got ${state.status}`)
		}

		if (!unblockConditionMet) {
			return invalid("Resume requires the Unblock Condition to be confirmed")
		}

		const origin = state.blockedFrom ?? "READY_FOR_IMPLEMENTATION"

		switch (origin) {
			case "READY_FOR_IMPLEMENTATION":
			case "IMPLEMENTATION":
				if (!isTaskStatusTransition("BLOCKED", "READY_FOR_IMPLEMENTATION")) {
					return invalid(
						"Status transition BLOCKED -> READY_FOR_IMPLEMENTATION is not a canonical task status transition",
					)
				}

				return { type: "resume_implementation", status: "READY_FOR_IMPLEMENTATION" }

			case "ANALYSIS":
				return this.resumeToStage(state, "ANALYSIS", "sublimation")

			case "READY_FOR_REFACTOR":
			case "REFACTOR":
				return this.resumeToStage(state, "READY_FOR_REFACTOR", "refactor")

			case "READY_FOR_REVIEW":
			case "REVIEW":
				return this.resumeToStage(state, "READY_FOR_REVIEW", "reviewer")

			case "REVIEW_PASSED":
			case "QA_READY":
				return this.resumeToStage(state, "REVIEW_PASSED", "qa")

			// `PLAN_READY`, `DONE`, and `BLOCKED` cannot produce a `BLOCKED` stop
			// (no stage runs in them), so an origin of one is a corrupted record —
			// refuse the resume instead of guessing a destination.
			default:
				return invalid(`Cannot resume a task blocked from ${origin}`)
		}
	}

	/**
	 * The resume-to-stage half: validate the canonical `BLOCKED` → entry edge and
	 * re-enter the stage that owns the origin status.
	 *
	 * The failure tracking is preserved only for fix-pass origins (`REFACTOR`,
	 * `REVIEW`, `QA_READY`), where the re-verification continues the same
	 * remediation budget; a stage-entry origin resumes with a cleared block.
	 */
	private resumeToStage(state: TaskState, entryStatus: TaskStatus, mode: LifecycleMode): LifecycleResult {
		if (!isTaskStatusTransition("BLOCKED", entryStatus)) {
			return invalid(`Status transition BLOCKED -> ${entryStatus} is not a canonical task status transition`)
		}

		const fixPassInFlight = state.blockedFrom !== null && state.blockedFrom !== entryStatus
		const failure = fixPassInFlight
			? { key: state.failureKey, attempts: state.failureAttempts, total: state.totalFailureAttempts }
			: undefined

		return { type: "start_mode", status: entryStatus, mode, failure }
	}

	/**
	 * Approve the plan and open the implementation queue.
	 *
	 * `PLAN_READY` is not routable from a stage outcome — no mode runs while the
	 * task waits for approval — so the harness owns this action, mirroring `resume`
	 * for `BLOCKED`. The caller has already obtained the user's approval; `ModeRunner`
	 * writes the status and `TaskScheduler` assigns the first ready unit.
	 *
	 * Pure and side-effect free, like `transition` and `resume`.
	 */
	approvePlan(state: TaskState): LifecycleResult {
		if (state.status !== "PLAN_READY") {
			return invalid(`Plan approval is only valid from PLAN_READY, got ${state.status}`)
		}

		// Reuse the same canonical-transition guard `resume` relies on, so the status
		// the runner writes cannot drift from the README machine.
		if (!isTaskStatusTransition("PLAN_READY", "READY_FOR_IMPLEMENTATION")) {
			return invalid(
				"Status transition PLAN_READY -> READY_FOR_IMPLEMENTATION is not a canonical task status transition",
			)
		}

		return { type: "resume_implementation", status: "READY_FOR_IMPLEMENTATION" }
	}

	/**
	 * Confirm the QA outcome of a task stopped at `QA_READY` and finish the task.
	 *
	 * `QA_READY` is a user gate like `PLAN_READY`: the QA stage stops there with
	 * `PENDING` because the recorded evidence needs a human confirmation, and no
	 * stage outcome may finish the task on the user's behalf. This harness-owned
	 * action — mirroring `approvePlan` for `PLAN_READY` — is the deterministic way
	 * to `DONE`. Valid only from `QA_READY`; every other status is refused so the
	 * caller leaves the task unchanged.
	 *
	 * Pure and side-effect free, like `transition`, `resume` and `approvePlan`;
	 * `ModeRunner` applies the result.
	 */
	approveQa(state: TaskState): LifecycleResult {
		if (state.status !== "QA_READY") {
			return invalid(`QA confirmation is only valid from QA_READY, got ${state.status}`)
		}

		// Reuse the same canonical-transition guard `approvePlan` relies on, so the
		// status the runner writes cannot drift from the README machine.
		if (!isTaskStatusTransition("QA_READY", "DONE")) {
			return invalid("Status transition QA_READY -> DONE is not a canonical task status transition")
		}

		return { type: "stop", status: "DONE", reason: "done" }
	}

	/**
	 * Decide whether the lifecycle may advance from the current canonical state
	 * alone, without a stage outcome.
	 *
	 * This is the "the state already allows the next step — take it" half of the
	 * model. `transition` reacts to a stage that just finished; `resolve` reacts to
	 * a state that is already routable (for example `ANALYSIS` with a complete
	 * plan, or `IMPLEMENTATION` after a unit completed), so the chain no longer
	 * depends on a delegated child stage or on the model re-analysing the
	 * artifacts.
	 *
	 * Pure and side-effect free, like `transition` and `resume`; `ModeRunner`
	 * applies the result. The returned status is validated against the canonical
	 * status machine here, so nothing outside this table is ever persisted.
	 */
	resolve(input: LifecycleResolveInput): LifecycleResult {
		const { state, artifacts, report, requirePlanApproval = true } = input
		const decision = this.decideFromState(state, artifacts, report, requirePlanApproval)

		// `schedule_implementation` defers the write to TaskScheduler, which owns its
		// own preconditions and re-derives the canonical status from the DAG.
		if (decision.type === "invalid" || decision.type === "schedule_implementation") {
			return decision
		}

		// Re-writing the current status is a no-op, not a transition: `ModeRunner`
		// skips the write, which keeps idempotent markers such as `READY_FOR_REFACTOR`
		// legal without inventing self-loop edges in the canonical table.
		if (decision.status !== state.status && !isTaskStatusTransition(state.status, decision.status)) {
			return invalid(
				`Status transition ${state.status} -> ${decision.status} is not a canonical task status transition`,
			)
		}

		return decision
	}

	/**
	 * The plan-approval gate decision.
	 *
	 * Shared by the Sublimation stage outcome and the state-only `ANALYSIS` path
	 * so both routes produce an identical decision: stop at `PLAN_READY` when the
	 * gate is on, otherwise open the implementation queue directly.
	 */
	private planApprovalGate(requirePlanApproval: boolean): LifecycleResult {
		return requirePlanApproval
			? { type: "stop", status: "PLAN_READY", reason: "plan-approval" }
			: { type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" }
	}

	private decideFromState(
		state: TaskState,
		artifacts: LifecycleResolveInput["artifacts"],
		report: LifecycleResolveInput["report"],
		requirePlanApproval: boolean,
	): LifecycleResult {
		switch (state.status) {
			case "ANALYSIS": {
				// Missing plan/directory are warnings at `ANALYSIS`, so `report.valid`
				// alone is not enough: the analysis is only "ready" when the plan and
				// the implementation directory exist and at least one unit was parsed.
				const blocking = report.issues.some(
					(issue) =>
						issue.code === "missing-implementation-plan" ||
						issue.code === "missing-implementation-directory",
				)

				const ready = report.valid && !blocking && artifacts.tasks.length > 0
				if (!ready) {
					return invalid("analysis artifacts are not ready; the sublimation stage must run")
				}

				// The plan is complete, but the gate may require a human approval before
				// the implementation queue opens — the same stop the Sublimation stage
				// outcome produces, reached here from the state alone.
				return this.planApprovalGate(requirePlanApproval)
			}

			case "PLAN_READY":
				return invalid("plan approval is a harness-owned action")

			case "READY_FOR_IMPLEMENTATION":
			case "IMPLEMENTATION":
				// The concrete unit (or the transition to Refactor when every unit is
				// done) is decided by `ModeRunner`/`TaskScheduler`, not here.
				return { type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" }

			case "READY_FOR_REFACTOR":
				return { type: "start_mode", status: "READY_FOR_REFACTOR", mode: "refactor" }

			case "READY_FOR_REVIEW":
				return { type: "start_mode", status: "READY_FOR_REVIEW", mode: "reviewer" }

			case "REVIEW_PASSED":
				return { type: "start_mode", status: "REVIEW_PASSED", mode: "qa" }

			case "REFACTOR":
			case "REVIEW":
			case "QA_READY":
				return invalid("a fix pass is in flight; the harness does not advance")

			case "DONE":
				return invalid("task is done")

			case "BLOCKED":
				return invalid("task is blocked; resume is a harness-owned action")

			default:
				return assertNever(state.status)
		}
	}

	private decide(state: TaskState, outcome: StageOutcome, requirePlanApproval: boolean): LifecycleResult {
		if (outcome.result === "BLOCKED") {
			// Record the origin: the harness-owned resume returns the task there
			// instead of always re-entering the implementation queue, so stages
			// that already passed are not re-run after a block.
			return { type: "stop", status: "BLOCKED", reason: "blocked", blockedFrom: state.status }
		}

		if (outcome.result === "NOT_APPLICABLE") {
			// A defensive report, not a stage outcome: the stage observed a status
			// it does not own and did nothing. Refuse it for every mode so the
			// caller falls back to the state-only continue, which routes the task
			// from the canonical state.
			return invalid(
				"Stage result NOT_APPLICABLE is not a stage outcome; the harness routes from the canonical state",
			)
		}

		switch (outcome.mode) {
			case "sublimation":
				if (outcome.result !== "COMPLETED") {
					return unsupported(outcome.mode, outcome.result)
				}

				// A finished analysis either opens the implementation queue directly or,
				// when the gate is on, stops for a human plan approval first.
				return this.planApprovalGate(requirePlanApproval)

			case "code":
				// The assigned unit is no longer runnable because an internal,
				// schedulable cause was discovered (a dependency on another unit).
				// The harness removes this cause itself: park the unit and let the
				// scheduler recompute the DAG. Only an assigned unit can ask for
				// this; a fix pass (REFACTOR/REVIEW/QA_READY) is not in the DAG.
				if (outcome.result === "RESCHEDULE_REQUIRED") {
					return state.status === "IMPLEMENTATION"
						? { type: "reschedule_implementation", status: "READY_FOR_IMPLEMENTATION" }
						: unsupported(outcome.mode, outcome.result)
				}

				if (outcome.result !== "COMPLETED") {
					return unsupported(outcome.mode, outcome.result)
				}

				// An assigned implementation unit continues the DAG (the scheduler picks
				// the next ready unit); a remediation pass returns to its requesting stage.
				return state.status === "IMPLEMENTATION"
					? { type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" }
					: reverifyRequestingStage(state.status, {
							key: state.failureKey,
							attempts: state.failureAttempts,
							total: state.totalFailureAttempts,
						})

			case "refactor":
				switch (outcome.result) {
					case "COMPLETED":
						return { type: "start_mode", status: "READY_FOR_REVIEW", mode: "reviewer" }
					case "FUNCTIONAL_DEFECT":
						return startFixPass(state, outcome, { type: "start_mode", status: "REFACTOR", mode: "code" })
					default:
						return unsupported(outcome.mode, outcome.result)
				}

			case "reviewer":
				switch (outcome.result) {
					case "PASSED":
						return { type: "start_mode", status: "REVIEW_PASSED", mode: "qa" }
					case "REQUIRED":
					case "PRODUCTION_FIX_REQUIRED":
						return startFixPass(state, outcome, { type: "start_mode", status: "REVIEW", mode: "code" })
					default:
						return unsupported(outcome.mode, outcome.result)
				}

			case "qa":
				switch (outcome.result) {
					case "PENDING":
						return { type: "stop", status: "QA_READY", reason: "pending" }
					case "PASSED":
						return { type: "stop", status: "DONE", reason: "done" }
					case "FAILED":
						return startFixPass(state, outcome, { type: "start_mode", status: "QA_READY", mode: "code" })
					default:
						return unsupported(outcome.mode, outcome.result)
				}

			default:
				return assertNever(outcome.mode)
		}
	}
}
