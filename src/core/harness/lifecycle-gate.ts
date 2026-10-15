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

import { LIFECYCLE_MODES, type TaskStatus } from "@roo-code/core"

/**
 * Canonical statuses that are harness-owned gates. No stage mode may run in
 * them, and only a harness-owned action leaves them.
 */
export const HARNESS_GATE_STATUSES = ["PLAN_READY", "BLOCKED"] as const

export type HarnessGateStatus = (typeof HARNESS_GATE_STATUSES)[number]

/**
 * Runtime modes that own a lifecycle stage. Launching one of these while the
 * task sits on a harness-owned gate would bypass the gate. Derived from the
 * domain vocabulary so this adapter list cannot drift from `LIFECYCLE_MODES`.
 */
export const STAGE_MODES = LIFECYCLE_MODES

export type StageMode = (typeof STAGE_MODES)[number]

export function isHarnessGateStatus(status: TaskStatus): status is HarnessGateStatus {
	return HARNESS_GATE_STATUSES.some((gate) => gate === status)
}

export function isStageMode(mode: string): mode is StageMode {
	return STAGE_MODES.some((stage) => stage === mode)
}

/**
 * Stable names for the harness gates. A rejection carries the name of the gate
 * that produced it, so the enforcement point can attribute the
 * `harness.gate.rejected` record to exactly one gate.
 */
export const HARNESS_GATE_NAMES = ["stage-launch", "artifact-mutation", "stage-mode-switch", "unit-mutation"] as const

export type HarnessGateName = (typeof HARNESS_GATE_NAMES)[number]

/**
 * Event name for a gate rejection. The decision functions stay pure; the
 * enforcement points emit this record (see `gate-telemetry.ts`).
 */
export const HARNESS_GATE_REJECTED_EVENT = "harness.gate.rejected"

export type GateRejection = {
	readonly allowed: false
	readonly reason: string
	/** Which gate rejected, so the enforcement point can attribute the warn record. */
	readonly gate: HarnessGateName
}

export type GateDecision = { readonly allowed: true } | GateRejection

export type StageLaunchGateDecision = GateDecision

export type StageModeSwitchGateDecision = GateDecision

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

	return {
		allowed: false,
		gate: "stage-launch",
		reason: gateRejectionReason(status, "no stage mode may be launched"),
	}
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

export type ArtifactMutationGateDecision = GateDecision

/**
 * Whether `targetPath` is the canonical task README inside `artifactsRoot`.
 *
 * Compared on the two paths as given (the enforcement point resolves both to
 * absolute paths), so a task-subdirectory README stays model-writable.
 */
export function isCanonicalReadme(targetPath: string, artifactsRoot: string): boolean {
	return path.resolve(targetPath) === path.resolve(path.join(artifactsRoot, "README.md"))
}

/**
 * Whether a model file-mutation tool may write to `targetPath` while the task
 * is in `status`.
 *
 * Two rules, both protecting harness-owned state at the tool boundary:
 *
 * 1. On a harness-owned gate (`PLAN_READY`, `BLOCKED`) the whole artifacts root
 *    is read-only for model tools: no stage mode runs there, and the only way
 *    out is a harness-owned action.
 * 2. Outside the gates, the canonical `README.md` stays read-only in every
 *    status except `ANALYSIS`: the canonical block is harness-owned (only
 *    `CanonicalReadmeWriter` and the scheduler write it), and a model edit that
 *    corrupts it is detected only after the fact — a duplicate `Status:` line
 *    makes the whole state resolver throw. `ANALYSIS` is the one exception:
 *    the Sublimation stage authors the README there (it is a listed stage
 *    artifact), so the gate does not block the authoring stage.
 *
 * Every other status and path combination is legitimate — code writes the
 * assigned unit in `IMPLEMENTATION` — and every path outside the artifacts
 * root is untouched.
 */
export function evaluateArtifactMutationGate(
	targetPath: string,
	artifactsRoot: string,
	status: TaskStatus,
): ArtifactMutationGateDecision {
	if (isHarnessGateStatus(status) && isPathInsideDirectory(targetPath, artifactsRoot)) {
		return {
			allowed: false,
			gate: "artifact-mutation",
			reason: gateRejectionReason(status, "task artifacts are read-only for model tools"),
		}
	}

	if (status !== "ANALYSIS" && isCanonicalReadme(targetPath, artifactsRoot)) {
		return {
			allowed: false,
			gate: "artifact-mutation",
			reason:
				"The canonical task README is harness-owned: model tools may not modify it outside the " +
				"ANALYSIS stage that authors it. Record stage output in the stage artifacts " +
				"(handoff.md, the review report, qa.md) instead.",
		}
	}

	return { allowed: true }
}

export type StageModeSwitchGateInput = {
	/**
	 * Canonical lifecycle status. Part of the gate input for symmetry with the
	 * other gates; the current rule does not depend on it.
	 */
	readonly status: TaskStatus
	readonly currentMode: string
	readonly targetMode: string
	readonly hasParentTask: boolean
}

/**
 * Whether a delegated stage child may switch its own mode to `targetMode`.
 *
 * A stage child is an executor of one stage: the harness owns stage
 * transitions, so a child must not move itself into another stage mode (the
 * incident: a code child switching to `orchestrator`). A root task may switch
 * freely, a child may leave the stage modes (ordinary delegation), and a no-op
 * switch to the current mode is allowed as today.
 */
export function evaluateStageModeSwitchGate(input: StageModeSwitchGateInput): GateDecision {
	const { currentMode, targetMode, hasParentTask } = input

	if (hasParentTask && isStageMode(currentMode) && isStageMode(targetMode) && targetMode !== currentMode) {
		return {
			allowed: false,
			gate: "stage-mode-switch",
			reason:
				`A delegated stage child cannot switch from ${currentMode} to ${targetMode}: stage ` +
				"transitions are owned by the harness. Complete the current stage with attempt_completion " +
				"instead of switching modes.",
		}
	}

	return { allowed: true }
}

export type UnitMutationGateInput = {
	readonly targetPath: string
	readonly artifactsRoot: string
	readonly status: TaskStatus
	/** Absolute path of the unit assigned to the executing child, or `null`. */
	readonly assignedArtifact: string | null
	readonly hasParentTask: boolean
	readonly currentMode: string
}

/**
 * Whether a delegated stage child may mutate `targetPath` while the task is in
 * `status`.
 *
 * During `IMPLEMENTATION` a delegated stage child owns exactly one unit: it may
 * write its assigned artifact but not another unit's file in `implementation/`
 * (the incident: a child rewrote the next unit's artifact before that unit
 * started). The restriction applies only to delegated stage children — the
 * chain owner (root code task) keeps today's freedom to propagate contract
 * changes into dependent units, and every path outside `implementation/` is
 * untouched.
 */
export function evaluateUnitMutationGate(input: UnitMutationGateInput): GateDecision {
	const { targetPath, artifactsRoot, status, assignedArtifact, hasParentTask, currentMode } = input

	if (status !== "IMPLEMENTATION" || !hasParentTask || !isStageMode(currentMode)) {
		return { allowed: true }
	}

	const implementationRoot = path.join(artifactsRoot, "implementation")

	if (!isPathInsideDirectory(targetPath, implementationRoot)) {
		return { allowed: true }
	}

	if (assignedArtifact && path.resolve(targetPath) === path.resolve(assignedArtifact)) {
		return { allowed: true }
	}

	return {
		allowed: false,
		gate: "unit-mutation",
		reason:
			"A delegated stage child may only mutate its assigned implementation unit" +
			`${assignedArtifact ? ` (${assignedArtifact})` : ""}; ${targetPath} belongs to another unit. ` +
			"Contract propagation stays with the chain owner (see handoff.md).",
	}
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
			"approved. The orchestrator approves it with the `approve_plan` tool; a user does the " +
			'same with "Approve Plan" (zoo-code.approvePlan). The harness then starts the next stage.'
		)
	}

	return (
		`The task is on the harness-owned BLOCKED gate: ${subject} until the blocker is ` +
		"resolved. The harness resumes the task only after the recorded Unblock Condition is " +
		"met (see handoff.md and the stage artifact)."
	)
}
