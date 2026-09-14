/**
 * Worktree Module
 *
 * Platform-agnostic git worktree management functionality.
 * These exports are decoupled from VSCode and can be used by any consumer.
 */

// Types
export * from "./types.js"

// Services
export { WorktreeService, worktreeService } from "./worktree-service.js"
export { WorktreeIncludeService, worktreeIncludeService, type CopyProgressCallback } from "./worktree-include.js"
export { TaskResolver, TaskResolutionError, type TaskContext, type TaskResolveContext } from "./task-resolver.js"
export { TaskStateResolver, TaskStateError, type TaskState, type TaskStatus } from "./task-state.js"

// Implementation artifact model and DAG helpers
export {
	TxxParser,
	parseImplementationTask,
	parseTaskIds,
	readyTasks,
	sortTasks,
	findDependencyCycles,
	hasUnclosedCodeFence,
	isFileNotFound,
	IMPLEMENTATION_TASK_STATUSES,
	type ImplementationTask,
	type ImplementationTaskStatus,
	type ImplementationArtifacts,
	type ImplementationFileSystem,
} from "./txx-parser.js"

// Structural artifact validation
export {
	ArtifactValidator,
	formatArtifactValidationIssues,
	type ArtifactValidationCode,
	type ArtifactValidationIssue,
	type ArtifactValidationOptions,
	type ArtifactValidationReport,
	type ArtifactValidationSeverity,
	type ArtifactFileSystem,
} from "./artifact-validator.js"

// DAG scheduler
export {
	TaskScheduler,
	type SchedulerPlan,
	type TaskAssignment,
	type TaskSchedulerFileSystem,
} from "./task-scheduler.js"

// Task workspace (git worktree) management
export {
	WorkspaceManager,
	WorkspaceError,
	type TaskWorkspace,
	type WorkspaceFileSystem,
	type WorkspaceGit,
	type WorkspaceManagerOptions,
} from "./workspace-manager.js"
