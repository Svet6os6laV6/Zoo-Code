import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"

import type { TaskContext } from "../task-resolver.js"
import { TaskScheduler } from "../task-scheduler.js"

describe("TaskScheduler integration", () => {
	it("assigns the next ready unit and persists it in the README", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "task-scheduler-"))
		const taskRoot = path.join(workspacePath, ".roo", "tasks", "SITESUP-1116")
		const implementation = path.join(taskRoot, "implementation")
		const readmePath = path.join(taskRoot, "README.md")
		const context: TaskContext = {
			taskId: "SITESUP-1116",
			branch: "feature/SITESUP-1116-heartbeat",
			taskRoot,
		}

		try {
			await fs.mkdir(implementation, { recursive: true })
			await fs.writeFile(
				readmePath,
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: READY_FOR_IMPLEMENTATION\nCurrent Task: NONE\nNext Step: Start implementation.\n",
			)
			await fs.writeFile(path.join(implementation, "T01-trigger.md"), "## Status\nStatus: DONE\n")
			await fs.writeFile(
				path.join(implementation, "T02-worker.md"),
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
			)

			const assignment = await new TaskScheduler().assignNext(context, {
				taskId: "SITESUP-1116",
				status: "READY_FOR_IMPLEMENTATION",
				currentTask: null,
				currentTaskArtifact: null,
				failureKey: null,
				failureAttempts: 0,
			})

			expect(assignment).toMatchObject({
				relativeArtifact: "implementation/T02-worker.md",
				state: { status: "IMPLEMENTATION", currentTask: "T02" },
			})
			await expect(fs.readFile(readmePath, "utf8")).resolves.toBe(`Protocol Version: 2
Task: SITESUP-1116
Status: IMPLEMENTATION
Current Task: implementation/T02-worker.md
Next Step: Implement T02 (implementation/T02-worker.md).
`)
			await expect(fs.readdir(taskRoot)).resolves.not.toContain(`${path.basename(readmePath)}.${process.pid}.tmp`)
		} finally {
			await fs.rm(workspacePath, { recursive: true, force: true })
		}
	})
})
