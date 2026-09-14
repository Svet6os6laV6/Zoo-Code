import { execFile } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import type { TaskContext } from "../task-resolver.js"
import { WorkspaceManager } from "../workspace-manager.js"

const execFileAsync = promisify(execFile)

async function execGit(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" })
	return stdout
}

describe.sequential("WorkspaceManager integration", () => {
	it("prepares, inspects, and cleans up a task worktree", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-manager-"))
		const repositoryPath = path.join(tempDir, "repo")
		const taskRoot = path.join(repositoryPath, ".roo", "tasks", "SITESUP-1116")
		const context: TaskContext = {
			taskId: "SITESUP-1116",
			branch: "feature/SITESUP-1116-heartbeat",
			taskRoot,
		}

		try {
			await fs.mkdir(repositoryPath, { recursive: true })
			await execGit(repositoryPath, ["init"])
			await execGit(repositoryPath, ["config", "user.name", "Test User"])
			await execGit(repositoryPath, ["config", "user.email", "test@example.com"])
			await execGit(repositoryPath, ["config", "commit.gpgSign", "false"])
			await fs.writeFile(path.join(repositoryPath, "README.md"), "base")
			await execGit(repositoryPath, ["add", "README.md"])
			await execGit(repositoryPath, ["commit", "-m", "init"])

			const manager = new WorkspaceManager(undefined, { repositoryPath })
			const workspace = await manager.prepareTaskWorkspace(context)

			expect(workspace.created).toBe(true)
			expect(workspace.branch).toBe("agent/SITESUP-1116")
			await expect(fs.stat(workspace.path)).resolves.toBeDefined()

			// A second call must reuse the worktree instead of failing.
			await expect(manager.prepareTaskWorkspace(context)).resolves.toMatchObject({ created: false })

			await fs.writeFile(path.join(workspace.path, "README.md"), "changed")
			await expect(manager.getDiff(workspace)).resolves.toContain("+changed")

			await manager.cleanup(workspace, true)
			await expect(fs.stat(workspace.path)).rejects.toThrow()
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true })
		}
	})
})
