import * as path from "path"

import type { TaskContext } from "../../worktree/task-resolver.js"
import { TaskScheduler } from "../../worktree/task-scheduler.js"
import { TaskStateResolver } from "../../worktree/task-state.js"
import { createInMemoryFileSystem } from "../../worktree/__tests__/helpers/in-memory-fs.js"
import { LifecycleController, ModeRunner, parseStageOutcome, type StageOutcome } from "../index.js"

const taskRoot = path.join("/workspace", ".roo", "tasks", "SITESUP-1119")
const readmePath = path.join(taskRoot, "README.md")
const implementation = path.join(taskRoot, "implementation")
const context: TaskContext = { taskId: "SITESUP-1119", branch: "feature/SITESUP-1119", taskRoot }

const controller = new LifecycleController()

function readme(status: string, currentTask: string): string {
	return `Protocol Version: 2\nTask: SITESUP-1119\nStatus: ${status}\nCurrent Task: ${currentTask}\n`
}

function outcome(mode: string, text: string): StageOutcome {
	const parsed = parseStageOutcome(mode, text)
	if (!parsed) {
		throw new Error(`expected a parsed stage outcome for ${mode}: ${text}`)
	}
	return parsed
}

/**
 * The deterministic regression for the BLOCKED deadlock: an assigned unit that
 * discovers an internal dependency must reschedule the DAG, not stop the
 * lifecycle. The full loop is exercised — T02 parks, T03 runs, T02 is reassigned,
 * and the lifecycle reaches Refactor — so the unblock condition is reachable.
 */
describe("reschedule deadlock", () => {
	it("recomputes the DAG instead of stopping when the assigned unit discovers a dependency", async () => {
		const fileSystem = createInMemoryFileSystem({
			[readmePath]: readme("IMPLEMENTATION", "implementation/T02-unit.md"),
			[path.join(implementation, "T02-unit.md")]:
				"## Status\nStatus: IN_PROGRESS\n\n## Relationships\n\n- Depends on: T03\n",
			[path.join(implementation, "T03-unit.md")]: "## Status\nStatus: TODO\n",
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

		// Code(T02) discovers it needs T03 and reports the internal cause.
		const state = await resolver.resolve(context)
		const decision = controller.transition(state, outcome("code", "Stage Result: RESCHEDULE_REQUIRED"))
		expect(decision).toEqual({ type: "reschedule_implementation", status: "READY_FOR_IMPLEMENTATION" })

		const result = await runner.run(context, state, decision)
		expect(result).toEqual({ type: "started", mode: "code", status: "IMPLEMENTATION" })
		expect(starts).toEqual(["code"])
		// T03 is now the current unit; T02 is parked and will be ready after T03.
		expect(fileSystem.files.get(readmePath)).toContain("Current Task: implementation/T03-unit.md")
		expect(fileSystem.files.get(path.join(implementation, "T02-unit.md"))).toContain("Status: TODO")

		// Code(T03) completes.
		fileSystem.files.set(path.join(implementation, "T03-unit.md"), "## Status\nStatus: DONE\n")
		const afterT03 = await resolver.resolve(context)
		const t03Decision = controller.transition(afterT03, outcome("code", "Stage Result: COMPLETED"))
		expect(t03Decision).toEqual({ type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" })

		const t03Result = await runner.run(context, afterT03, t03Decision)
		expect(t03Result).toEqual({ type: "started", mode: "code", status: "IMPLEMENTATION" })
		// T02 is ready again and reassigned.
		expect(fileSystem.files.get(readmePath)).toContain("Current Task: implementation/T02-unit.md")

		// Code(T02) completes; every unit is done, so the lifecycle moves to Refactor.
		fileSystem.files.set(path.join(implementation, "T02-unit.md"), "## Status\nStatus: DONE\n")
		const afterT02 = await resolver.resolve(context)
		const t02Decision = controller.transition(afterT02, outcome("code", "Stage Result: COMPLETED"))
		const t02Result = await runner.run(context, afterT02, t02Decision)
		expect(t02Result).toEqual({ type: "started", mode: "refactor", status: "READY_FOR_REFACTOR" })
	})
})
