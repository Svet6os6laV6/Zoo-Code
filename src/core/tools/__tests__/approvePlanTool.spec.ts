// npx vitest run core/tools/__tests__/approvePlanTool.spec.ts

import type { TaskStatus } from "@roo-code/core"

import type { ToolUse } from "../../../shared/tools"
import type { PlanApprovalOutcome } from "../../harness/plan-approval"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"

// The tool resolves the canonical task state through `TaskStateResolver`; the
// resolver is replaced so the spec controls the status the guard observes.
const resolveState = vi.hoisted(() => vi.fn())

vi.mock("@roo-code/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@roo-code/core")>()
	return {
		...actual,
		TaskStateResolver: class {
			resolve = resolveState
		},
	}
})

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Tool Error: ${msg}`),
	},
}))

import { approvePlanTool } from "../ApprovePlanTool"

const taskContext = {
	taskId: "fix-2",
	branch: "feature/fix-2",
	taskRoot: "/workspace/.roo/tasks/fix-2",
}

const stateWith = (status: TaskStatus) => ({
	taskId: taskContext.taskId,
	status,
	currentTask: null,
	currentTaskArtifact: null,
	failureKey: null,
	failureAttempts: 0,
})

const approvedOutcome = (overrides: Partial<PlanApprovalOutcome> = {}): PlanApprovalOutcome => ({
	approved: true,
	status: "IMPLEMENTATION",
	currentTask: "implementation/T01-first-unit.md",
	reason: null,
	...overrides,
})

describe("approvePlanTool", () => {
	let mockCallbacks: ToolCallbacks
	let mockApprovePlanForTask: ReturnType<typeof vi.fn>

	// The provider is a structural double: the tool only uses `providerRef.deref()`
	// and `approvePlanForTask`, so the double carries exactly that capability.
	function makeTask(): Task {
		return {
			taskId: taskContext.taskId,
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			getTaskContext: vi.fn().mockResolvedValue(taskContext),
			providerRef: {
				deref: vi.fn().mockReturnValue({ approvePlanForTask: mockApprovePlanForTask }),
			},
		} as unknown as Task
	}

	function createBlock(reason?: string): ToolUse<"approve_plan"> {
		return {
			type: "tool_use" as const,
			name: "approve_plan" as const,
			params: {},
			partial: false,
			nativeArgs: { reason },
		} as unknown as ToolUse<"approve_plan">
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockApprovePlanForTask = vi.fn().mockResolvedValue(approvedOutcome())
		resolveState.mockResolvedValue(stateWith("PLAN_READY"))
		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	it("approves a PLAN_READY task and reports the unit the harness assigned", async () => {
		const task = makeTask()

		await approvePlanTool.handle(task, createBlock(), mockCallbacks)

		expect(mockApprovePlanForTask).toHaveBeenCalledWith(task)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("implementation/T01-first-unit.md"),
		)
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Plan approved"))
	})

	it("asks for the ordinary tool approval before leaving the gate", async () => {
		const task = makeTask()

		await approvePlanTool.handle(task, createBlock("Plan reviewed"), mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining('"approvePlan"'))
		expect(mockCallbacks.askApproval).toHaveBeenCalledWith("tool", expect.stringContaining("Plan reviewed"))
	})

	it("does not approve when the user declines the tool approval", async () => {
		const task = makeTask()
		vi.mocked(mockCallbacks.askApproval).mockResolvedValue(false)

		await approvePlanTool.handle(task, createBlock(), mockCallbacks)

		expect(mockApprovePlanForTask).not.toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("rejects the call without approving when the task is not at PLAN_READY", async () => {
		const task = makeTask()
		resolveState.mockResolvedValue(stateWith("IMPLEMENTATION"))

		await approvePlanTool.handle(task, createBlock(), mockCallbacks)

		expect(mockApprovePlanForTask).not.toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("PLAN_READY"))
	})

	it("fails closed when the canonical state cannot be read", async () => {
		const task = makeTask()
		resolveState.mockRejectedValue(new Error("no harness context"))

		await approvePlanTool.handle(task, createBlock(), mockCallbacks)

		expect(mockApprovePlanForTask).not.toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Tool Error"))
	})

	it("leaves the guard paths out of the mistake accounting", async () => {
		const task = makeTask()
		resolveState.mockResolvedValue(stateWith("READY_FOR_IMPLEMENTATION"))

		await approvePlanTool.handle(task, createBlock(), mockCallbacks)

		// A guard, not a model error: nothing is counted and no tool error recorded.
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(task.recordToolError).not.toHaveBeenCalled()
	})

	it("reports the harness reason when the approval was not applied", async () => {
		const task = makeTask()
		mockApprovePlanForTask.mockResolvedValue({
			approved: false,
			status: null,
			currentTask: null,
			reason: "Task fix-2 was not approved; the harness left it unchanged.",
		})

		await approvePlanTool.handle(task, createBlock(), mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("the harness left it unchanged"),
		)
	})

	it("reports a substantial next stage when no unit is assigned", async () => {
		const task = makeTask()
		mockApprovePlanForTask.mockResolvedValue(approvedOutcome({ status: "READY_FOR_REFACTOR", currentTask: null }))

		await approvePlanTool.handle(task, createBlock(), mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining("No implementation unit is assigned"),
		)
	})

	it("reports the provider loss without approving", async () => {
		const task = {
			taskId: taskContext.taskId,
			getTaskContext: vi.fn().mockResolvedValue(taskContext),
			providerRef: { deref: vi.fn().mockReturnValue(undefined) },
		} as unknown as Task

		await approvePlanTool.handle(task, createBlock(), mockCallbacks)

		expect(mockApprovePlanForTask).not.toHaveBeenCalled()
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("Provider reference lost"))
	})
})
