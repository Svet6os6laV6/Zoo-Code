import { z } from "zod"

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
	"BLOCKED",
	"NOT_APPLICABLE",
] as const

/**
 * The `Stage Result` protocol marker: the one line a stage uses to report its
 * semantic outcome. Both the instruction sent to the model and the parser that
 * reads the reply are derived from this constant, so the two cannot drift.
 */
export const STAGE_RESULT_MARKER = "Stage Result:"

const lifecycleModeSchema = z.enum(LIFECYCLE_MODES)
const stageResultSchema = z.enum(STAGE_RESULTS)

export type LifecycleMode = z.infer<typeof lifecycleModeSchema>
export type StageResult = z.infer<typeof stageResultSchema>

/** What a stage reported, derived from runtime state rather than model routing. */
export type StageOutcome = {
	readonly mode: LifecycleMode
	readonly result: StageResult
}

export type LifecycleResult =
	| { readonly type: "start_mode"; readonly status: TaskStatus; readonly mode: LifecycleMode }
	| { readonly type: "schedule_implementation"; readonly status: TaskStatus }
	| { readonly type: "stop"; readonly status: TaskStatus; readonly reason: "done" | "pending" | "blocked" }
	| { readonly type: "invalid"; readonly reason: string }

export type ModeRunResult =
	| { readonly type: "started"; readonly mode: LifecycleMode; readonly status: TaskStatus }
	| { readonly type: "stopped"; readonly status: TaskStatus; readonly reason: "done" | "pending" | "blocked" }
	| { readonly type: "invalid"; readonly reason: string }

export class LifecycleError extends Error {
	override readonly name = "LifecycleError"
}

function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Built from {@link STAGE_RESULT_MARKER}; global so `matchAll` can count matches. */
const STAGE_RESULT_PATTERN = new RegExp(`^\\s*${escapeForRegExp(STAGE_RESULT_MARKER)}\\s*(\\S+)\\s*$`, "gim")

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

	const parsedResult = stageResultSchema.safeParse(matches[0]?.[1]?.toUpperCase())
	return parsedResult.success ? { mode: parsedMode.data, result: parsedResult.data } : null
}
