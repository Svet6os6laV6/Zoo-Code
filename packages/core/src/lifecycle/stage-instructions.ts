/**
 * Stage instructions
 *
 * Builds the message `ModeRunner` sends when it starts a stage. The instruction is
 * a *pointer*, not a payload: it names the artifacts the stage works from (paths
 * relative to the task artifact directory) and the one outcome marker to report.
 * The canonical README state and the assigned unit already reach every mode
 * through the system prompt, so duplicating their contents here would only create
 * two sources of truth for the same facts.
 *
 * Everything a stage needs is data: adding a stage is a row in `STAGE_ARTIFACTS`
 * and `STAGE_DIRECTIVES`, not new prose threaded through the runner.
 */

import {
	STAGE_FAILURE_KEY_MARKER,
	STAGE_RESULT_MARKER,
	type FailureTracking,
	type LifecycleMode,
} from "./lifecycle-types.js"

/**
 * The artifacts each stage works from, as paths relative to the task artifact
 * directory (`Task artifacts` in the system prompt). A directory entry such as
 * `implementation/` tells the stage where a family of artifacts lives without
 * pinning it to one file.
 */
export const STAGE_ARTIFACTS = {
	architect: ["README.md"],
	code: ["README.md"],
	refactor: ["README.md", "implementation/"],
	reviewer: ["README.md", "implementation/", "handoff.md"],
	qa: ["README.md", "handoff.md", "qa.md"],
} as const satisfies Record<LifecycleMode, readonly string[]>

/**
 * One line describing what the stage is responsible for. The detailed procedure
 * stays in the mode's own rules; this only orients a stage that was started by the
 * harness rather than by the user.
 *
 * The `code` directive also carries the outcome classification, because it is the
 * only stage that can discover an internal dependency while working an assigned
 * unit. Reporting `BLOCKED` for a schedulable cause would stop the lifecycle and
 * deadlock the DAG, so the distinction is stated where the stage is started.
 */
export const STAGE_DIRECTIVES = {
	architect: "Produce or update the implementation plan artifacts.",
	code: "Implement the assigned implementation unit, or the reported fix. Report RESCHEDULE_REQUIRED when the unit cannot proceed until another unit in implementation/ is done: record the dependency and the progress notes in the unit artifact first. Report BLOCKED only for obstacles the harness cannot remove itself (a user decision, missing credentials, an unavailable external service).",
	refactor: "Restructure the completed implementation without changing behaviour.",
	reviewer: "Review the implementation against the requirements and record findings.",
	qa: "Verify the reviewed work against the acceptance criteria and record evidence in qa.md, including three ready-to-use commit message variants describing the task's changes.",
} as const satisfies Record<LifecycleMode, string>

export type StageInstructionInput = {
	readonly mode: LifecycleMode
	readonly taskId: string
	/** Assigned implementation unit, as a path relative to the task root, or `null`. */
	readonly assignedArtifact: string | null
	/** Failure tracking when the controller is starting a fix pass. */
	readonly failure?: FailureTracking
}

/**
 * Compose the instruction for one stage start.
 *
 * The marker the instruction asks for is the same constant `parseStageOutcome`
 * matches, so the prompt and the parser cannot drift. The failure line is added
 * only while a fix pass is in flight, and it tells the stage to repeat the key so
 * the controller keeps counting against the same finding.
 */
export function buildStageInstruction(input: StageInstructionInput): string {
	const { mode, taskId, assignedArtifact, failure } = input
	const parts = [`Run the ${mode} stage for ${taskId}.`, STAGE_DIRECTIVES[mode]]

	const artifacts: string[] = [...STAGE_ARTIFACTS[mode]]
	if (assignedArtifact) {
		artifacts.push(assignedArtifact)
	}
	if (artifacts.length > 0) {
		parts.push(`Task artifacts are relative to the task artifact directory: ${artifacts.join(", ")}.`)
	}

	if (failure && (failure.key !== null || failure.attempts > 0)) {
		const finding = failure.key ?? "an unnamed finding"
		parts.push(
			`This is fix pass ${failure.attempts} for ${finding}; report the same ${STAGE_FAILURE_KEY_MARKER} ${finding} if it is still present.`,
		)
	}

	parts.push(
		`Report the semantic outcome as one '${STAGE_RESULT_MARKER} <RESULT>' line. Do not select the next mode or lifecycle status.`,
	)

	return parts.join(" ")
}
