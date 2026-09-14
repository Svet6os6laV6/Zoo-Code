/**
 * WorkspaceManager
 *
 * Prepares and inspects the isolated working tree for one task.
 *
 * The model never runs `git worktree add` itself. The harness creates a
 * dedicated worktree per task (`../worktrees/<TASK>` on branch `agent/<TASK>`),
 * so the main working tree is never touched and a future sandbox can mount the
 * task worktree instead of the host repository.
 *
 * The current lifecycle is sequential: every implementation unit of a task runs
 * in the same task worktree. Parallel execution can later create one worktree
 * per implementation unit without changing this contract.
 */

import { promises as fs } from "fs"
import * as path from "path"

import type { TaskContext } from "./task-resolver.js"
import type { Worktree } from "./types.js"
import { worktreeService, type WorktreeService } from "./worktree-service.js"

const DEFAULT_BRANCH_PREFIX = "agent/"
const DEFAULT_WORKTREES_DIRECTORY = "worktrees"

export type WorkspaceGit = Pick<
	WorktreeService,
	"checkGitRepo" | "getGitRootPath" | "listWorktrees" | "createWorktree" | "deleteWorktree" | "getDiff"
>

export type WorkspaceFileSystem = {
	rm(dirPath: string, options: { recursive: boolean; force: boolean }): Promise<void>
}

export type WorkspaceManagerOptions = {
	/** Repository the task worktree is created from. Derived from the task root by default. */
	readonly repositoryPath?: string
	/** Directory that holds per-task worktrees. Defaults to `<repository parent>/worktrees`. */
	readonly worktreesRoot?: string
	/** Branch prefix for task branches. Defaults to `agent/`. */
	readonly branchPrefix?: string
	/** Base ref for a newly created task branch. Defaults to the repository HEAD. */
	readonly baseBranch?: string
}

export type TaskWorkspace = {
	readonly taskId: string
	readonly repositoryPath: string
	readonly path: string
	readonly branch: string
	readonly worktree: Worktree | undefined
	/** False when an existing worktree for this task was reused. */
	readonly created: boolean
}

export class WorkspaceError extends Error {
	override readonly name = "WorkspaceError"
}

export class WorkspaceManager {
	constructor(
		private readonly git: WorkspaceGit = worktreeService,
		private readonly options: WorkspaceManagerOptions = {},
		private readonly fileSystem: WorkspaceFileSystem = fs,
	) {}

	/**
	 * Create (or reuse) the worktree for a task. Idempotent: a second call for the
	 * same task returns the existing worktree instead of failing.
	 */
	async prepareTaskWorkspace(context: TaskContext): Promise<TaskWorkspace> {
		const repositoryPath = this.options.repositoryPath ?? deriveRepositoryPath(context)
		const branch = `${this.options.branchPrefix ?? DEFAULT_BRANCH_PREFIX}${context.taskId}`
		const worktreesRoot =
			this.options.worktreesRoot ??
			path.join(path.dirname(path.resolve(repositoryPath)), DEFAULT_WORKTREES_DIRECTORY)
		const worktreePath = path.join(worktreesRoot, context.taskId)

		if (!(await this.git.checkGitRepo(repositoryPath))) {
			throw new WorkspaceError(`Not a git repository: ${repositoryPath}`)
		}

		const existing = (await this.git.listWorktrees(repositoryPath)).find(
			(worktree) => path.resolve(worktree.path) === path.resolve(worktreePath),
		)

		if (existing) {
			return {
				taskId: context.taskId,
				repositoryPath,
				path: worktreePath,
				branch: existing.branch || branch,
				worktree: existing,
				created: false,
			}
		}

		let result = await this.git.createWorktree(repositoryPath, {
			path: worktreePath,
			branch,
			baseBranch: this.options.baseBranch,
			createNewBranch: true,
		})

		if (!result.success) {
			// The branch may already exist from an earlier session for this task.
			result = await this.git.createWorktree(repositoryPath, {
				path: worktreePath,
				branch,
				createNewBranch: false,
			})
		}

		if (!result.success) {
			throw new WorkspaceError(result.message)
		}

		return {
			taskId: context.taskId,
			repositoryPath,
			path: worktreePath,
			branch,
			worktree: result.worktree,
			created: true,
		}
	}

	/**
	 * Unified diff of the task workspace, optionally against a base ref.
	 */
	async getDiff(workspace: TaskWorkspace, base?: string): Promise<string> {
		return this.git.getDiff(workspace.path, base ?? this.options.baseBranch)
	}

	/**
	 * Remove the task worktree. The task branch is deleted only when it is already
	 * merged, so unmerged work is never lost.
	 */
	async cleanup(workspace: TaskWorkspace, force = false): Promise<void> {
		const result = await this.git.deleteWorktree(workspace.repositoryPath, workspace.path, force)

		if (!result.success) {
			throw new WorkspaceError(result.message)
		}

		await this.fileSystem.rm(workspace.path, { recursive: true, force: true })
	}
}

/**
 * The task root is `<workspace>/.roo/tasks/<TASK>`, so the repository is three
 * levels up. Callers that know the workspace path should pass it explicitly.
 */
function deriveRepositoryPath(context: TaskContext): string {
	return path.resolve(context.taskRoot, "..", "..", "..")
}
