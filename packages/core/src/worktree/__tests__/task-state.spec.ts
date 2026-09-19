import * as path from "path"

import { TASK_STATUS_TRANSITIONS, TaskStateError, TaskStateResolver, isTaskStatusTransition } from "../task-state.js"
import type { TaskContext } from "../task-resolver.js"

const taskContext: TaskContext = {
	taskId: "SITESUP-1116",
	branch: "feature/SITESUP-1116-heartbeat",
	taskRoot: path.join("/workspace", ".roo", "tasks", "SITESUP-1116"),
}

function resolverFor(readme: string): TaskStateResolver {
	return new TaskStateResolver({ readFile: async () => readme })
}

describe("TaskStateResolver", () => {
	it("resolves lifecycle state and the current implementation unit", async () => {
		const state = await resolverFor(`Protocol Version: 2
Task: SITESUP-1116
Status: IMPLEMENTATION
Current Task: implementation/T02-worker-heartbeat.md
Next Step: Implement T02.
`).resolve(taskContext)

		expect(state).toEqual({
			taskId: "SITESUP-1116",
			status: "IMPLEMENTATION",
			currentTask: "T02",
			currentTaskArtifact: path.join(taskContext.taskRoot, "implementation", "T02-worker-heartbeat.md"),
		})
	})

	it("represents a new task without README as analysis", async () => {
		const resolver = new TaskStateResolver({
			readFile: async () => {
				throw Object.assign(new Error("missing"), { code: "ENOENT" })
			},
		})

		await expect(resolver.resolve(taskContext)).resolves.toEqual({
			taskId: "SITESUP-1116",
			status: "ANALYSIS",
			currentTask: null,
			currentTaskArtifact: null,
		})
	})

	it("rejects an implementation state without a current implementation unit", async () => {
		await expect(
			resolverFor(`Protocol Version: 2
Task: SITESUP-1116
Status: IMPLEMENTATION
Current Task: NONE
`).resolve(taskContext),
		).rejects.toEqual(new TaskStateError("IMPLEMENTATION requires Current Task"))
	})

	it("rejects a current implementation unit outside the task artifact directory", async () => {
		await expect(
			resolverFor(`Protocol Version: 2
Task: SITESUP-1116
Status: IMPLEMENTATION
Current Task: ../T02.md
`).resolve(taskContext),
		).rejects.toEqual(new TaskStateError("Invalid Current Task: ../T02.md"))
	})

	it("rejects a README task identity mismatch", async () => {
		await expect(
			resolverFor(`Protocol Version: 2
Task: SITESUP-9999
Status: ANALYSIS
Current Task: NONE
`).resolve(taskContext),
		).rejects.toEqual(new TaskStateError("Task identity mismatch: expected SITESUP-1116, got SITESUP-9999"))
	})

	it("uses trusted runtime identity for a legacy README", async () => {
		await expect(
			resolverFor(`Status: DONE
Current Task: NONE
`).resolve(taskContext),
		).resolves.toEqual({
			taskId: "SITESUP-1116",
			status: "DONE",
			currentTask: null,
			currentTaskArtifact: null,
		})
	})

	it("preserves legacy implementation fallback when Current Task is absent", async () => {
		await expect(resolverFor("Status: IN_PROGRESS\n").resolve(taskContext)).resolves.toEqual({
			taskId: "SITESUP-1116",
			status: "IMPLEMENTATION",
			currentTask: null,
			currentTaskArtifact: null,
		})
	})

	it("rejects an invalid lifecycle transition", () => {
		expect(() => TaskStateResolver.transition("ANALYSIS", "QA_READY")).toThrow(
			new TaskStateError("Invalid task state transition: ANALYSIS -> QA_READY"),
		)
	})

	it("accepts an implementation self-transition", () => {
		expect(TaskStateResolver.transition("IMPLEMENTATION", "IMPLEMENTATION")).toBe("IMPLEMENTATION")
	})

	it.each([
		["READY_FOR_REVIEW", "REVIEW_PASSED"],
		["REVIEW", "REVIEW_PASSED"],
		["REVIEW_PASSED", "DONE"],
		["REVIEW", "READY_FOR_REVIEW"],
		["REFACTOR", "READY_FOR_REFACTOR"],
		["QA_READY", "REVIEW_PASSED"],
	] as const)("accepts the %s -> %s edge the lifecycle stages rely on", (current, next) => {
		expect(TaskStateResolver.transition(current, next)).toBe(next)
		expect(isTaskStatusTransition(current, next)).toBe(true)
	})

	it("reports a rejected edge without throwing", () => {
		expect(isTaskStatusTransition("DONE", "IMPLEMENTATION")).toBe(false)
	})

	it("documents the remediation markers as edges out of their own stage", () => {
		expect(TASK_STATUS_TRANSITIONS.REVIEW).toContain("READY_FOR_REVIEW")
		expect(TASK_STATUS_TRANSITIONS.REFACTOR).toContain("READY_FOR_REFACTOR")
		expect(TASK_STATUS_TRANSITIONS.QA_READY).toContain("REVIEW_PASSED")
	})
})
