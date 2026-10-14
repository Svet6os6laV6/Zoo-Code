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
 * `stop` at `BLOCKED` parks the assigned unit before the write clears
 * `Current Task`, so the resume returns the task to the implementation queue,
 * clears the blocker's failure tracking, and the scheduler hands the same unit
 * back — the recovery the reported task needed.
 */
describe("BLOCKED resume", () => {
	it("parks the assigned unit at BLOCKED and reassigns it on resume", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: `Protocol Version: 2
Task: SITESUP-1119
Status: IMPLEMENTATION
Current Task: implementation/T03-max-client-config.md
Next Step: Implement T03 (implementation/T03-max-client-config.md).
Failure Key: NONE
Failure Attempts: 0
`,
			[path.join(implementation, "T03-max-client-config.md")]: "## Status\nStatus: IN_PROGRESS\n",
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
		expect(state.status).toBe("IMPLEMENTATION")
		expect(state.currentTaskArtifact).toBe(path.join(implementation, "T03-max-client-config.md"))

		// Code reports a cause the harness cannot remove on its own.
		const blocked = controller.transition(state, { mode: "code", result: "BLOCKED", failureKey: null })
		expect(blocked).toEqual({ type: "stop", status: "BLOCKED", reason: "blocked" })

		const stopped = await runner.run(context, state, blocked)
		expect(stopped).toEqual({ type: "stopped", status: "BLOCKED", reason: "blocked" })
		expect(starts).toEqual([])

		// The assignment is parked before `Current Task` is cleared, so the unit is
		// ready for the DAG instead of stranded as `current-unit-unfinished`.
		expect(fileSystem.files.get(path.join(implementation, "T03-max-client-config.md"))).toContain("Status: TODO")
		const blockedReadme = fileSystem.files.get(readmePath) ?? ""
		expect(blockedReadme).toContain("Status: BLOCKED")
		expect(blockedReadme).toContain("Current Task: NONE")

		// A confirmed Unblock Condition resumes the task and assigns T03 again.
		const blockedState = await resolver.resolve(context)
		expect(blockedState.status).toBe("BLOCKED")

		const decision = controller.resume(blockedState, true)
		expect(decision).toEqual({ type: "resume_implementation", status: "READY_FOR_IMPLEMENTATION" })

		const result = await runner.run(context, blockedState, decision)
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
