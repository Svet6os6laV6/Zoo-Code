import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"

import { TaskStateResolver } from "../task-state.js"
import type { TaskContext } from "../task-resolver.js"

describe("TaskStateResolver integration", () => {
	it("reads the current implementation unit from the task README", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-state-"))
		const taskRoot = path.join(workspacePath, ".roo", "tasks", "SITESUP-1116")
		const context: TaskContext = {
			taskId: "SITESUP-1116",
			branch: "feature/SITESUP-1116-heartbeat",
			taskRoot,
		}

		try {
			await fs.mkdir(path.join(taskRoot, "implementation"), { recursive: true })
			await fs.writeFile(
				path.join(taskRoot, "README.md"),
				`Protocol Version: 2
Task: SITESUP-1116
Status: IMPLEMENTATION
Current Task: implementation/T02-worker-heartbeat.md
Next Step: Implement T02.
`,
			)

			await expect(new TaskStateResolver().resolve(context)).resolves.toEqual({
				taskId: "SITESUP-1116",
				status: "IMPLEMENTATION",
				currentTask: "T02",
				currentTaskArtifact: path.join(taskRoot, "implementation", "T02-worker-heartbeat.md"),
			})
		} finally {
			await fs.rm(workspacePath, { recursive: true, force: true })
		}
	})
})
