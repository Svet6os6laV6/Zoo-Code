import { isTaskStatusTransition, type TaskState, type TaskStatus } from "../worktree/task-state.js"

import {
	LifecycleError,
	type LifecycleMode,
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
	architect: ["ANALYSIS"],
	code: ["IMPLEMENTATION", "REFACTOR", "REVIEW", "QA_READY"],
	refactor: ["READY_FOR_REFACTOR", "REFACTOR"],
	reviewer: ["READY_FOR_REVIEW", "REVIEW"],
	qa: ["REVIEW_PASSED", "QA_READY"],
} as const satisfies Record<LifecycleMode, readonly TaskStatus[]>

function invalid(reason: string): LifecycleResult {
	return { type: "invalid", reason }
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
function reverifyRequestingStage(status: TaskStatus): LifecycleResult {
	switch (status) {
		case "REFACTOR":
			return { type: "start_mode", status: "READY_FOR_REFACTOR", mode: "refactor" }
		case "REVIEW":
			return { type: "start_mode", status: "READY_FOR_REVIEW", mode: "reviewer" }
		case "QA_READY":
			return { type: "start_mode", status: "REVIEW_PASSED", mode: "qa" }
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
	transition(state: TaskState, outcome: StageOutcome): LifecycleResult {
		if (!MODE_STATUSES[outcome.mode].some((status) => status === state.status)) {
			return invalid(`Mode ${outcome.mode} cannot complete lifecycle status ${state.status}`)
		}

		const decision = this.decide(state, outcome)

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

	private decide(state: TaskState, outcome: StageOutcome): LifecycleResult {
		if (outcome.result === "BLOCKED") {
			return { type: "stop", status: "BLOCKED", reason: "blocked" }
		}

		switch (outcome.mode) {
			case "architect":
				return outcome.result === "COMPLETED"
					? { type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" }
					: unsupported(outcome.mode, outcome.result)

			case "code":
				if (outcome.result !== "COMPLETED") {
					return unsupported(outcome.mode, outcome.result)
				}

				// An assigned implementation unit continues the DAG (the scheduler picks
				// the next ready unit); a remediation pass returns to its requesting stage.
				return state.status === "IMPLEMENTATION"
					? { type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" }
					: reverifyRequestingStage(state.status)

			case "refactor":
				switch (outcome.result) {
					case "COMPLETED":
						return { type: "start_mode", status: "READY_FOR_REVIEW", mode: "reviewer" }
					case "FUNCTIONAL_DEFECT":
						return { type: "start_mode", status: "REFACTOR", mode: "code" }
					default:
						return unsupported(outcome.mode, outcome.result)
				}

			case "reviewer":
				switch (outcome.result) {
					case "PASSED":
						return { type: "start_mode", status: "REVIEW_PASSED", mode: "qa" }
					case "REQUIRED":
					case "PRODUCTION_FIX_REQUIRED":
						return { type: "start_mode", status: "REVIEW", mode: "code" }
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
						return { type: "start_mode", status: "QA_READY", mode: "code" }
					default:
						return unsupported(outcome.mode, outcome.result)
				}

			default:
				return assertNever(outcome.mode)
		}
	}
}
