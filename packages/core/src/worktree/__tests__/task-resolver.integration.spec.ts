import { execFile } from "child_process"
import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"

import { TaskResolver } from "../task-resolver.js"

const execFileAsync = promisify(execFile)

describe("TaskResolver integration", () => {
	it("resolves from Git without reading task artifacts", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-resolver-"))
		try {
			await execFileAsync("git", ["init"], { cwd: workspacePath })
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
				{
					cwd: workspacePath,
				},
			)
			await execFileAsync("git", ["checkout", "-b", "feature/SITESUP-1116-heartbeat"], {
				cwd: workspacePath,
			})
			await fs.mkdir(path.join(workspacePath, ".roo"))
			await fs.writeFile(path.join(workspacePath, ".roo", "tasks"), "not a directory")

			const resolution = await new TaskResolver().resolve({ workspacePath })

			expect(resolution.taskId).toBe("SITESUP-1116")
			expect(resolution.taskRoot).toBe(path.join(workspacePath, ".roo", "tasks", "SITESUP-1116"))
		} finally {
			await fs.rm(workspacePath, { recursive: true, force: true })
		}
	})
})
