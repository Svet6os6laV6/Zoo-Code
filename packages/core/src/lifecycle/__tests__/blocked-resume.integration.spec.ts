import * as path from "path"

import type { TaskContext } from "../../worktree/task-resolver.js"
import { TaskScheduler } from "../../worktree/task-scheduler.js"
import { TaskStateResolver } from "../../worktree/task-state.js"
import { createInMemoryFileSystem } from "../../worktree/__tests__/helpers/in-memory-fs.js"
import { LifecycleController, ModeRunner } from "../index.js"

const taskRoot = path.join("/workspace", ".roo", "tasks", "SITESUP-1119")
const readmePath = path.join(taskRoot, "README.md")
const implementation = path.join(taskRoot, "implementation")
const context: TaskContext = { taskId: "SITESUP-1119", branch: "feature/SITESUP-1119", taskRoot }

const controller = new LifecycleController()

/**
 * The regression for the BLOCKED deadlock: a task that stopped at `BLOCKED` (an
 * external cause) must be resumable through the harness-owned resume action. The
 * resume returns it to the implementation queue, clears the blocker's failure
 * tracking, and the scheduler assigns the next ready unit — the same recovery the
 * reported task needed.
 */
describe("BLOCKED resume", () => {
	it("returns a blocked task to the implementation queue and assigns the next ready unit", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: `Protocol Version: 2
Task: SITESUP-1119
Status: BLOCKED
Current Task: NONE
Next Step: Implement T02 (implementation/T02-multi-channel-delivery.md).
Failure Key: blocked-external
Failure Attempts: 1
`,
			// Mirrors the reported state: the assigned unit is parked, its channel
			// dependency (T03) is the only unit that is ready.
			[path.join(implementation, "T02-multi-channel-delivery.md")]:
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01, T03\n",
			[path.join(implementation, "T03-max-client-config.md")]: "## Status\nStatus: TODO\n",
		})
		const resolver = new TaskStateResolver(fileSystem)
		const starts: string[] = []
		const runner = new ModeRunner(
			async (mode) => {
				starts.push(mode)
			},
			new TaskScheduler(fileSystem),
			fileSystem,
		)

		const state = await resolver.resolve(context)
		expect(state.status).toBe("BLOCKED")

		const decision = controller.resume(state, true)
		expect(decision).toEqual({ type: "resume_implementation", status: "READY_FOR_IMPLEMENTATION" })

		const result = await runner.run(context, state, decision)
		expect(result).toEqual({ type: "started", mode: "code", status: "IMPLEMENTATION" })
		expect(starts).toEqual(["code"])

		const readme = fileSystem.files.get(readmePath) ?? ""
		expect(readme).toContain("Status: IMPLEMENTATION")
		expect(readme).toContain("Current Task: implementation/T03-max-client-config.md")
		expect(readme).toContain("Failure Key: NONE")
		expect(readme).toContain("Failure Attempts: 0")
	})

	it("does not resume while the Unblock Condition is unconfirmed", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: "Protocol Version: 2\nTask: SITESUP-1119\nStatus: BLOCKED\nCurrent Task: NONE\n",
			[path.join(implementation, "T03-max-client-config.md")]: "## Status\nStatus: TODO\n",
		})
		const state = await new TaskStateResolver(fileSystem).resolve(context)

		expect(controller.resume(state, false)).toEqual({
			type: "invalid",
			reason: "Resume requires the Unblock Condition to be confirmed",
		})
	})
})
