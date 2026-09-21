import { execFile } from "child_process"
import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { TaskResolutionError, TaskResolver } from "../task-resolver.js"

const execFileAsync = promisify(execFile)

async function initGitRepo(workspacePath: string): Promise<void> {
	await execFileAsync("git", ["init"], { cwd: workspacePath })
}

/** Runs `scenario` against a throw-away workspace that is always removed afterwards. */
async function withTempWorkspace(scenario: (workspacePath: string) => Promise<void>): Promise<void> {
	const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-resolver-"))
	try {
		await scenario(workspacePath)
	} finally {
		await fs.rm(workspacePath, { recursive: true, force: true })
	}
}

async function commitEmpty(workspacePath: string): Promise<void> {
	await execFileAsync(
		"git",
		[
			"-c",
			"user.name=Zoo Code",
			"-c",
			"user.email=zoo@example.test",
			"commit",
			"--allow-empty",
			"-m",
			"Initial commit",
		],
		{ cwd: workspacePath },
	)
}

describe("TaskResolver integration", () => {
	it("resolves from Git and creates the missing .roo/tasks chain", async () => {
		await withTempWorkspace(async (workspacePath) => {
			await initGitRepo(workspacePath)
			await commitEmpty(workspacePath)
			await execFileAsync("git", ["checkout", "-b", "feature/SITESUP-1116-heartbeat"], {
				cwd: workspacePath,
			})

			const resolution = await new TaskResolver().resolve({ workspacePath })

			expect(resolution.taskId).toBe("SITESUP-1116")
			expect(resolution.taskRoot).toBe(path.join(workspacePath, ".roo", "tasks", "SITESUP-1116"))
			const taskRootStat = await fs.stat(resolution.taskRoot)
			expect(taskRootStat.isDirectory()).toBe(true)
		})
	})

	it("resolves an unborn branch without commits via the sanitized fallback", async () => {
		await withTempWorkspace(async (workspacePath) => {
			await initGitRepo(workspacePath)
			await execFileAsync("git", ["checkout", "-b", "webhook-mvp"], { cwd: workspacePath })

			const resolution = await new TaskResolver().resolve({ workspacePath })

			expect(resolution.taskId).toBe("webhook-mvp")
			expect(resolution.branch).toBe("webhook-mvp")
			expect(resolution.taskRoot).toBe(path.join(workspacePath, ".roo", "tasks", "webhook-mvp"))
			const taskRootStat = await fs.stat(resolution.taskRoot)
			expect(taskRootStat.isDirectory()).toBe(true)
		})
	})

	it("fails with a clear error when .roo/tasks is a file", async () => {
		await withTempWorkspace(async (workspacePath) => {
			await initGitRepo(workspacePath)
			await commitEmpty(workspacePath)
			await execFileAsync("git", ["checkout", "-b", "feature/SITESUP-1116-heartbeat"], {
				cwd: workspacePath,
			})
			await fs.mkdir(path.join(workspacePath, ".roo"))
			await fs.writeFile(path.join(workspacePath, ".roo", "tasks"), "not a directory")

			await expect(new TaskResolver().resolve({ workspacePath })).rejects.toBeInstanceOf(TaskResolutionError)
			await expect(new TaskResolver().resolve({ workspacePath })).rejects.toThrow(
				/Unable to create task root directory/,
			)
		})
	})
})
