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
export {
	TaskStateResolver,
	TaskStateError,
	TASK_STATUSES,
	TASK_STATUS_TRANSITIONS,
	isTaskStatusTransition,
	type TaskState,
	type TaskStatus,
} from "./task-state.js"

// Canonical task README block (single writer for the harness-owned fields)
export {
	CanonicalReadmeError,
	CanonicalReadmeWriter,
	readCanonicalFields,
	readmePath,
	writeCanonicalFields,
	writeReadmeAtomic,
	CANONICAL_README_FIELDS,
	NO_CURRENT_TASK,
	README_FILENAME,
	type CanonicalReadmeField,
	type CanonicalReadmeFields,
	type CanonicalReadmeSnapshot,
	type CanonicalReadmeUpdate,
	type ReadmeFileSystem,
} from "./task-readme.js"

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

// Implementation snapshot change detection
export { diffImplementationArtifacts, type ArtifactSnapshotDiff, type TaskUnitStatusChange } from "./artifact-diff.js"

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
