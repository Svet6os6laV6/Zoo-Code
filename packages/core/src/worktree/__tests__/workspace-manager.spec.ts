import * as path from "path"

import type { TaskContext } from "../task-resolver.js"
import type { Worktree } from "../types.js"
import { WorkspaceError, WorkspaceManager, type WorkspaceFileSystem, type WorkspaceGit } from "../workspace-manager.js"

const repositoryPath = "/workspace/repo"
const taskRoot = path.join(repositoryPath, ".roo", "tasks", "SITESUP-1116")
const worktreePath = path.join("/workspace", "worktrees", "SITESUP-1116")

const taskContext: TaskContext = {
	taskId: "SITESUP-1116",
	branch: "feature/SITESUP-1116-heartbeat",
	taskRoot,
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
	return {
		path: worktreePath,
		branch: "agent/SITESUP-1116",
		commitHash: "abc123",
		isCurrent: false,
		isBare: false,
		isDetached: false,
		isLocked: false,
		...overrides,
	}
}

function gitFor(overrides: Partial<WorkspaceGit> = {}): WorkspaceGit {
	return {
		checkGitRepo: vi.fn().mockResolvedValue(true),
		getGitRootPath: vi.fn().mockResolvedValue(repositoryPath),
		listWorktrees: vi.fn().mockResolvedValue([]),
		createWorktree: vi.fn().mockResolvedValue({ success: true, message: "created", worktree: worktree() }),
		deleteWorktree: vi.fn().mockResolvedValue({ success: true, message: "removed" }),
		getDiff: vi.fn().mockResolvedValue("diff"),
		...overrides,
	}
}

function fileSystemFor(): { fileSystem: WorkspaceFileSystem; rm: ReturnType<typeof vi.fn> } {
	const rm = vi.fn<(dirPath: string, options: { recursive: boolean; force: boolean }) => Promise<void>>()
	rm.mockResolvedValue(undefined)

	return { fileSystem: { rm }, rm }
}

describe("WorkspaceManager.prepareTaskWorkspace", () => {
	it("creates a task worktree on a dedicated branch", async () => {
		const git = gitFor()
		const workspace = await new WorkspaceManager(git, { repositoryPath }).prepareTaskWorkspace(taskContext)

		expect(git.createWorktree).toHaveBeenCalledWith(repositoryPath, {
			path: worktreePath,
			branch: "agent/SITESUP-1116",
			baseBranch: undefined,
			createNewBranch: true,
		})
		expect(workspace).toMatchObject({
			taskId: "SITESUP-1116",
			repositoryPath,
			path: worktreePath,
			branch: "agent/SITESUP-1116",
			created: true,
		})
	})

	it("reuses an existing worktree for the same task", async () => {
		const git = gitFor({ listWorktrees: vi.fn().mockResolvedValue([worktree()]) })
		const workspace = await new WorkspaceManager(git, { repositoryPath }).prepareTaskWorkspace(taskContext)

		expect(git.createWorktree).not.toHaveBeenCalled()
		expect(workspace).toMatchObject({ created: false, branch: "agent/SITESUP-1116" })
	})

	it("checks out an existing branch when the branch already exists", async () => {
		const createWorktree = vi
			.fn()
			.mockResolvedValueOnce({ success: false, message: "branch already exists" })
			.mockResolvedValueOnce({ success: true, message: "checked out", worktree: worktree() })
		const git = gitFor({ createWorktree })

		const workspace = await new WorkspaceManager(git, { repositoryPath }).prepareTaskWorkspace(taskContext)

		expect(createWorktree).toHaveBeenNthCalledWith(2, repositoryPath, {
			path: worktreePath,
			branch: "agent/SITESUP-1116",
			createNewBranch: false,
		})
		expect(workspace.created).toBe(true)
	})

	it("rejects a directory that is not a git repository", async () => {
		const git = gitFor({ checkGitRepo: vi.fn().mockResolvedValue(false) })

		await expect(new WorkspaceManager(git, { repositoryPath }).prepareTaskWorkspace(taskContext)).rejects.toEqual(
			new WorkspaceError(`Not a git repository: ${repositoryPath}`),
		)
	})

	it("reports a failed worktree creation", async () => {
		const git = gitFor({
			createWorktree: vi.fn().mockResolvedValue({ success: false, message: "Failed to create worktree" }),
		})

		await expect(new WorkspaceManager(git, { repositoryPath }).prepareTaskWorkspace(taskContext)).rejects.toEqual(
			new WorkspaceError("Failed to create worktree"),
		)
	})
})

describe("WorkspaceManager.getDiff", () => {
	it("delegates to the git service with the configured base ref", async () => {
		const git = gitFor()
		const manager = new WorkspaceManager(git, { repositoryPath, baseBranch: "main" })
		const workspace = await manager.prepareTaskWorkspace(taskContext)

		await expect(manager.getDiff(workspace)).resolves.toBe("diff")
		expect(git.getDiff).toHaveBeenCalledWith(worktreePath, "main")
	})
})

describe("WorkspaceManager.cleanup", () => {
	it("removes the worktree and its directory", async () => {
		const git = gitFor()
		const { fileSystem, rm } = fileSystemFor()
		const manager = new WorkspaceManager(git, { repositoryPath }, fileSystem)
		const workspace = await manager.prepareTaskWorkspace(taskContext)

		await manager.cleanup(workspace, true)

		expect(git.deleteWorktree).toHaveBeenCalledWith(repositoryPath, worktreePath, true)
		expect(rm).toHaveBeenCalledWith(worktreePath, { recursive: true, force: true })
	})

	it("reports a failed worktree removal", async () => {
		const git = gitFor({
			deleteWorktree: vi.fn().mockResolvedValue({ success: false, message: "Failed to delete worktree" }),
		})
		const manager = new WorkspaceManager(git, { repositoryPath }, fileSystemFor().fileSystem)
		const workspace = await manager.prepareTaskWorkspace(taskContext)

		await expect(manager.cleanup(workspace)).rejects.toEqual(new WorkspaceError("Failed to delete worktree"))
	})
})
