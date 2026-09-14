import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"

import { ArtifactValidator } from "../artifact-validator.js"
import type { TaskContext } from "../task-resolver.js"

describe("ArtifactValidator integration", () => {
	it("reports a dangling dependency from real artifacts", async () => {
		const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-validator-"))
		const taskRoot = path.join(workspacePath, ".roo", "tasks", "SITESUP-1116")
		const implementation = path.join(taskRoot, "implementation")
		const context: TaskContext = {
			taskId: "SITESUP-1116",
			branch: "feature/SITESUP-1116-heartbeat",
			taskRoot,
		}

		try {
			await fs.mkdir(implementation, { recursive: true })
			await fs.writeFile(
				path.join(taskRoot, "README.md"),
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T01-trigger.md\n",
			)
			await fs.writeFile(path.join(taskRoot, "implementation-plan.md"), "# Plan\n")
			await fs.writeFile(path.join(taskRoot, "handoff.md"), "# Handoff\n")
			await fs.writeFile(path.join(implementation, "T01-trigger.md"), "## Status\nStatus: DONE\n")
			await fs.writeFile(
				path.join(implementation, "T03-reconciler.md"),
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01, T99\n",
			)

			const report = await new ArtifactValidator().validate(context, { status: "IMPLEMENTATION" })

			expect(report.valid).toBe(false)
			expect(report.errors).toContainEqual({
				severity: "error",
				code: "unknown-dependency",
				taskId: "T03",
				message: "dependency T99 does not exist",
			})
		} finally {
			await fs.rm(workspacePath, { recursive: true, force: true })
		}
	})
})
