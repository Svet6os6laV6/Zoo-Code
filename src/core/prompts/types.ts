import type { ArtifactValidationIssue, TaskContext, TaskState } from "@roo-code/core"

/**
 * Settings passed to system prompt generation functions
 */
export interface SystemPromptSettings {
	todoListEnabled: boolean
	useAgentRules: boolean
	/** When true, recursively discover and load .roo/rules from subdirectories */
	enableSubfolderRules?: boolean
	newTaskRequireTodos: boolean
	/** When true, model should hide vendor/company identity in responses */
	isStealthModel?: boolean
	taskContext?: TaskContext
	taskState?: TaskState
	/** Structural artifact problems the model must repair. */
	artifactValidationIssues?: ArtifactValidationIssue[]
	/**
	 * Debug option: include the full assembled prompt in the harness log.
	 * Off by default; the prompt is always redacted before it is recorded.
	 */
	harnessLogFullPrompts?: boolean
}
