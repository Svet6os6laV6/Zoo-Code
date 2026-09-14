import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"

import type { TaskContext } from "../task-resolver.js"
import { readyTasks, TxxParser } from "../txx-parser.js"

describe("TxxParser integration", () => {
	it("reads the implementation DAG from disk", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "txx-parser-"))
		const taskRoot = path.join(workspacePath, ".roo", "tasks", "SITESUP-1116")
		const implementation = path.join(taskRoot, "implementation")
		const context: TaskContext = {
			taskId: "SITESUP-1116",
			branch: "feature/SITESUP-1116-heartbeat",
			taskRoot,
		}

		try {
			await fs.mkdir(implementation, { recursive: true })
			await fs.writeFile(path.join(implementation, "T01-trigger.md"), "## Status\nStatus: DONE\n")
			await fs.writeFile(
				path.join(implementation, "T02-worker.md"),
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
			)
			await fs.writeFile(
				path.join(implementation, "T03-reconciler.md"),
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
			)
			await fs.writeFile(
				path.join(implementation, "T04-integration.md"),
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T02, T03\n",
			)

			const artifacts = await new TxxParser().read(context)

			expect(artifacts.missingDirectory).toBe(false)
			expect(artifacts.tasks.map((task) => task.id)).toEqual(["T01", "T02", "T03", "T04"])
			expect(readyTasks(artifacts.tasks).map((task) => task.id)).toEqual(["T02", "T03"])
		} finally {
			await fs.rm(workspacePath, { recursive: true, force: true })
		}
	})
})
