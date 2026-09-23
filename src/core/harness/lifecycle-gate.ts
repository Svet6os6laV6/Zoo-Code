/**
 * LifecycleGate
 *
 * Enforcement of the harness-owned lifecycle gates at the model's tool boundary.
 *
 * `PLAN_READY` and `BLOCKED` are the two canonical statuses in which no stage
 * mode runs: the only way out is a harness-owned action (`approvePlan` for
 * `PLAN_READY`, `resume` for `BLOCKED`). The lifecycle model already encodes
 * this, but the model can still bypass it by launching a stage mode through
 * `new_task`. This module holds the shared vocabulary — the gate statuses, the
 * stage modes, and the pure decision — so every enforcement point (the
 * `new_task` launch gate and the artifact-mutation gate) uses one definition
 * instead of duplicating the lists.
 *
 * Pure: no filesystem, no logger, no side effects.
 */

import * as path from "path"

import type { TaskStatus } from "@roo-code/core"

/**
 * Canonical statuses that are harness-owned gates. No stage mode may run in
 * them, and only a harness-owned action leaves them.
 */
export const HARNESS_GATE_STATUSES = ["PLAN_READY", "BLOCKED"] as const

export type HarnessGateStatus = (typeof HARNESS_GATE_STATUSES)[number]

/**
 * Runtime modes that own a lifecycle stage. Launching one of these while the
 * task sits on a harness-owned gate would bypass the gate.
 */
export const STAGE_MODES = ["architect", "code", "refactor", "reviewer", "qa"] as const

export type StageMode = (typeof STAGE_MODES)[number]

export function isHarnessGateStatus(status: TaskStatus): status is HarnessGateStatus {
	return HARNESS_GATE_STATUSES.some((gate) => gate === status)
}

export function isStageMode(mode: string): mode is StageMode {
	return STAGE_MODES.some((stage) => stage === mode)
}

export type StageLaunchGateDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string }

/**
 * Whether a stage mode may be launched while the task is in `status`.
 *
 * Only the intersection of a harness-owned gate status and a stage mode is
 * rejected: every other status (where the stage is legitimate) and every
 * non-stage mode (ordinary delegation) is allowed.
 */
export function evaluateStageLaunchGate(status: TaskStatus, mode: string): StageLaunchGateDecision {
	if (!isStageMode(mode) || !isHarnessGateStatus(status)) {
		return { allowed: true }
	}

	return { allowed: false, reason: gateRejectionReason(status, "no stage mode may be launched") }
}

/**
 * Whether `targetPath` is inside `directory` (or is the directory itself).
 *
 * Pure string comparison on the two paths as given: callers pass absolute,
 * already-resolved paths. `path.relative` collapses `..`/`.` segments, and the
 * `isAbsolute` check covers the cross-drive case where `relative` cannot
 * express the relationship and returns the target unchanged.
 */
export function isPathInsideDirectory(targetPath: string, directory: string): boolean {
	const relative = path.relative(directory, targetPath)

	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export type ArtifactMutationGateDecision =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly reason: string }

/**
 * Whether a model file-mutation tool may write to `targetPath` while the task
 * is in `status`.
 *
 * The canonical task artifacts are read-only for model tools exactly while the
 * task sits on a harness-owned gate (`PLAN_READY`, `BLOCKED`): no stage mode
 * runs there, and the only way out is a harness-owned action. Every other
 * status is legitimate — the architect writes the plan in `ANALYSIS`, code
 * writes the assigned unit in `IMPLEMENTATION` — and every path outside the
 * artifacts root is untouched.
 */
export function evaluateArtifactMutationGate(
	targetPath: string,
	artifactsRoot: string,
	status: TaskStatus,
): ArtifactMutationGateDecision {
	if (!isHarnessGateStatus(status) || !isPathInsideDirectory(targetPath, artifactsRoot)) {
		return { allowed: true }
	}

	return { allowed: false, reason: gateRejectionReason(status, "task artifacts are read-only for model tools") }
}

/**
 * Rejection message for a harness-owned gate.
 *
 * `subject` names what the gate forbids in the current context — "no stage mode
 * may be launched" for the launch gate, "task artifacts are read-only for model
 * tools" for the mutation gate. The rest of the message is identical, so both
 * enforcement points share one definition.
 */
function gateRejectionReason(status: HarnessGateStatus, subject: string): string {
	if (status === "PLAN_READY") {
		return (
			`The task is on the harness-owned PLAN_READY gate: ${subject} until the plan is ` +
			'approved. Ask the user to run "Approve Plan" (zoo-code.approvePlan); the harness ' +
			"will then start the next stage."
		)
	}

	return (
		`The task is on the harness-owned BLOCKED gate: ${subject} until the blocker is ` +
		"resolved. The harness resumes the task only after the recorded Unblock Condition is " +
		"met (see handoff.md and the stage artifact)."
	)
}
