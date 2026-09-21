import { z } from "zod"

import { NO_FAILURE_KEY } from "../worktree/task-readme.js"
import type { TaskStatus } from "../worktree/task-state.js"

/**
 * The stage vocabulary of the harness lifecycle. These are mode slugs the user
 * configures (built-in or custom) — the controller never assumes a mode's
 * behaviour, only that these five *stages* exist and that each one reports an
 * outcome in the protocol below.
 */
export const LIFECYCLE_MODES = ["architect", "code", "refactor", "reviewer", "qa"] as const
export const STAGE_RESULTS = [
	"COMPLETED",
	"PASSED",
	"REQUIRED",
	"FUNCTIONAL_DEFECT",
	"PRODUCTION_FIX_REQUIRED",
	"PENDING",
	"FAILED",
	/**
	 * The stage is fine, but the unit it was assigned is no longer runnable: an
	 * internal, schedulable cause (a dependency on another implementation unit was
	 * discovered, so the DAG must be recomputed). The harness removes this cause
	 * itself, so the lifecycle keeps running instead of stopping.
	 */
	"RESCHEDULE_REQUIRED",
	/**
	 * The stage cannot proceed for a reason the harness cannot remove on its own:
	 * a user decision is needed, a credential is missing, an external service is
	 * unavailable, or the requirement is unclear. This is the only outcome that
	 * stops the lifecycle for a human.
	 */
	"BLOCKED",
	"NOT_APPLICABLE",
] as const

/**
 * The `Stage Result` protocol marker: the one line a stage uses to report its
 * semantic outcome. Both the instruction sent to the model and the parser that
 * reads the reply are derived from this constant, so the two cannot drift.
 */
export const STAGE_RESULT_MARKER = "Stage Result:"

/**
 * The optional `Failure Key` protocol marker. A failing stage may name the
 * finding it could not satisfy with a stable semantic id; the harness — not the
 * model — counts the fix passes spent on that id. Both the instruction and the
 * parser derive from this constant.
 */
export const STAGE_FAILURE_KEY_MARKER = "Failure Key:"

const lifecycleModeSchema = z.enum(LIFECYCLE_MODES)
const stageResultSchema = z.enum(STAGE_RESULTS)

export type LifecycleMode = z.infer<typeof lifecycleModeSchema>
export type StageResult = z.infer<typeof stageResultSchema>

/** What a stage reported, derived from runtime state rather than model routing. */
export type StageOutcome = {
	readonly mode: LifecycleMode
	readonly result: StageResult
	/**
	 * Semantic id of the finding the stage is reporting on, or `null` when the
	 * stage named none. A model may choose the id, but only the controller counts
	 * the attempts against it.
	 */
	readonly failureKey: string | null
}

/**
 * How many fix passes the harness has spent on one finding.
 *
 * The key is the semantic id a failing stage may report; the count is owned by
 * the controller, never by the model. A `null` key means the stage named no
 * finding, which still forms its own bucket so an unnamed loop is bounded too.
 */
export type FailureTracking = {
	readonly key: string | null
	readonly attempts: number
}

export type LifecycleResult =
	| {
			readonly type: "start_mode"
			readonly status: TaskStatus
			readonly mode: LifecycleMode
			/** Present when the decision must preserve or update failure tracking. */
			readonly failure?: FailureTracking
	  }
	| { readonly type: "schedule_implementation"; readonly status: TaskStatus }
	/**
	 * The assigned unit asked to be re-queued because it is no longer ready: the
	 * runner parks the unit (`IN_PROGRESS` → `TODO`), clears the assignment, and
	 * lets `TaskScheduler` recompute the DAG. Distinct from
	 * `schedule_implementation`, which continues the DAG from a unit that has
	 * already finished.
	 */
	| { readonly type: "reschedule_implementation"; readonly status: TaskStatus }
	/**
	 * A task stopped at `BLOCKED` resumes after the harness confirmed the Unblock
	 * Condition. No stage reported this — the harness owns the decision — so it is a
	 * separate variant from the stage-outcome results. The task returns to the
	 * implementation queue and `TaskScheduler` recomputes the DAG.
	 */
	| { readonly type: "resume_implementation"; readonly status: TaskStatus }
	| {
			readonly type: "stop"
			readonly status: TaskStatus
			readonly reason: "done" | "pending" | "blocked" | "max-attempts"
			/** Present when a max-attempts stop must surface the exhausted finding. */
			readonly failure?: FailureTracking
	  }
	| { readonly type: "invalid"; readonly reason: string }

export type ModeRunResult =
	| { readonly type: "started"; readonly mode: LifecycleMode; readonly status: TaskStatus }
	| {
			readonly type: "stopped"
			readonly status: TaskStatus
			readonly reason: "done" | "pending" | "blocked" | "max-attempts"
	  }
	| { readonly type: "invalid"; readonly reason: string }

export class LifecycleError extends Error {
	override readonly name = "LifecycleError"
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Built from {@link STAGE_RESULT_MARKER}; global so `matchAll` can count matches. */
const STAGE_RESULT_PATTERN = new RegExp(`^\\s*${escapeForRegExp(STAGE_RESULT_MARKER)}\\s*(\\S+)\\s*$`, "gim")

/** Built from {@link STAGE_FAILURE_KEY_MARKER}; global so `matchAll` can count matches. */
const STAGE_FAILURE_KEY_PATTERN = new RegExp(`^\\s*${escapeForRegExp(STAGE_FAILURE_KEY_MARKER)}\\s*(\\S+)\\s*$`, "gim")

/**
 * Read the outcome a stage reported, or `null` when the reply carries no
 * unambiguous result.
 *
 * Deliberately strict: the mode comes from runtime state, never from the text
 * (a model cannot route the lifecycle), and exactly one marker line must be
 * present. Anything else leaves the caller on its existing resume path instead of
 * guessing.
 */
export function parseStageOutcome(mode: string, text: string): StageOutcome | null {
	const parsedMode = lifecycleModeSchema.safeParse(mode)
	if (!parsedMode.success) {
		return null
	}

	const matches = [...text.matchAll(STAGE_RESULT_PATTERN)]
	if (matches.length !== 1) {
		return null
	}

	// The failure key is optional, but not ambiguous: a reply that names two
	// findings cannot be attributed to one remediation loop, so it is rejected like
	// a missing or duplicated `Stage Result`. The canonical `NONE` sentinel means
	// "no key" rather than a literal id.
	const failureKeyMatches = [...text.matchAll(STAGE_FAILURE_KEY_PATTERN)]
	if (failureKeyMatches.length > 1) {
		return null
	}

	const rawFailureKey = failureKeyMatches[0]?.[1]
	const failureKey =
		rawFailureKey === undefined || rawFailureKey.toUpperCase() === NO_FAILURE_KEY ? null : rawFailureKey

	const parsedResult = stageResultSchema.safeParse(matches[0]?.[1]?.toUpperCase())
	return parsedResult.success ? { mode: parsedMode.data, result: parsedResult.data, failureKey } : null
}
