// npx vitest run core/assistant-message/__tests__/presentAssistantMessage-artifact-mutation-gate.spec.ts

import type { Anthropic } from "@anthropic-ai/sdk"
import { describe, it, expect, beforeEach, vi } from "vitest"

import { presentAssistantMessage } from "../presentAssistantMessage"
import type { Task } from "../../task/Task"

const mockResolve = vi.hoisted(() => vi.fn())
const mockWriteToFileHandle = vi.hoisted(() => vi.fn())
const mockApplyPatchHandle = vi.hoisted(() => vi.fn())
const mockEvent = vi.hoisted(() => vi.fn())

vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
}))
vi.mock("../../tools/WriteToFileTool", () => ({
	writeToFileTool: { handle: mockWriteToFileHandle },
}))
vi.mock("../../tools/ApplyPatchTool", () => ({
	applyPatchTool: { handle: mockApplyPatchHandle },
}))
vi.mock("../../tools/ReadFileTool", () => ({
	readFileTool: {
		handle: vi.fn().mockResolvedValue(undefined),
		getReadFileToolDescription: vi.fn(() => "[read_file]"),
	},
}))
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureEvent: vi.fn(),
			captureException: vi.fn(),
		},
	},
}))
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		has: vi.fn(() => false),
		get: vi.fn(),
	},
	harnessLogger: () => ({ event: mockEvent }),
	TaskStateResolver: class {
		resolve = mockResolve
	},
}))

const TASK_ROOT = "/workspace/.roo/tasks/fix-01"

interface MockTask {
	taskId: string
	instanceId: string
	parentTaskId?: string
	abort: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	currentStreamingContentIndex: number
	currentStreamingDidCheckpoint: boolean
	assistantMessageContent: unknown[]
	userMessageContent: Anthropic.ToolResultBlockParam[]
	didCompleteReadingStream: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	consecutiveMistakeCount: number
	clineMessages: unknown[]
	cwd: string
	api: { getModel: () => { id: string; info: Record<string, unknown> } }
	recordToolUsage: ReturnType<typeof vi.fn>
	recordToolError: ReturnType<typeof vi.fn>
	getTaskMode: ReturnType<typeof vi.fn>
	getTaskContext: ReturnType<typeof vi.fn>
	getHarnessLogContext: ReturnType<typeof vi.fn>
	toolRepetitionDetector: { check: ReturnType<typeof vi.fn> }
	providerRef: {
		deref: () => {
			getState: ReturnType<typeof vi.fn>
		}
	}
	say: ReturnType<typeof vi.fn>
	ask: ReturnType<typeof vi.fn>
	pushToolResultToUserContent: ReturnType<typeof vi.fn>
}

function writeToFileBlock(relPath: string) {
	return {
		type: "tool_use",
		id: "tool_call_write_1",
		name: "write_to_file",
		params: { path: relPath, content: "new content" },
		nativeArgs: { path: relPath, content: "new content" },
		partial: false,
	}
}

function applyPatchBlock(relPath: string) {
	const patch = `*** Begin Patch\n*** Update File: ${relPath}\n@@\n-old\n+new\n*** End Patch`

	return {
		type: "tool_use",
		id: "tool_call_patch_1",
		name: "apply_patch",
		params: { patch },
		nativeArgs: { patch },
		partial: false,
	}
}

describe("presentAssistantMessage - artifact mutation gate", () => {
	let mockTask: MockTask

	beforeEach(() => {
		vi.clearAllMocks()

		mockTask = {
			taskId: "test-task-id",
			instanceId: "test-instance",
			parentTaskId: undefined,
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			currentStreamingDidCheckpoint: true,
			assistantMessageContent: [],
			userMessageContent: [],
			didCompleteReadingStream: false,
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			clineMessages: [],
			cwd: "/workspace",
			api: {
				getModel: () => ({ id: "test-model", info: {} }),
			},
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			getTaskMode: vi.fn().mockResolvedValue("code"),
			getTaskContext: vi.fn().mockResolvedValue({
				taskId: "fix-01",
				branch: "fix-01",
				taskRoot: TASK_ROOT,
			}),
			getHarnessLogContext: vi.fn().mockResolvedValue({ taskId: "fix-01", traceId: "trace-1" }),
			toolRepetitionDetector: {
				check: vi.fn().mockReturnValue({ allowExecution: true }),
			},
			providerRef: {
				deref: () => ({
					getState: vi.fn().mockResolvedValue({
						mode: "code",
						customModes: [],
						experiments: { customTools: false },
					}),
				}),
			},
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			pushToolResultToUserContent: vi.fn(),
		}

		mockTask.pushToolResultToUserContent = vi
			.fn()
			.mockImplementation((toolResult: Anthropic.ToolResultBlockParam) => {
				const existingResult = mockTask.userMessageContent.find(
					(block) => block.type === "tool_result" && block.tool_use_id === toolResult.tool_use_id,
				)
				if (existingResult) {
					return false
				}
				mockTask.userMessageContent.push(toolResult)
				return true
			})
	})

	it("rejects a mutation of an artifact while the task is on PLAN_READY", async () => {
		mockResolve.mockResolvedValue({ status: "PLAN_READY" })
		mockTask.assistantMessageContent = [writeToFileBlock(".roo/tasks/fix-01/implementation/T01-x.md")]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockWriteToFileHandle).not.toHaveBeenCalled()
		expect(mockTask.userMessageContent).toHaveLength(1)
		expect(mockTask.userMessageContent[0].content).toContain("PLAN_READY")
		expect(mockTask.userMessageContent[0].content).toContain("read-only")
		// The existing gate rejection is recorded too.
		expect(mockEvent).toHaveBeenCalledWith(
			"harness.gate.rejected",
			expect.objectContaining({
				level: "warn",
				attributes: expect.objectContaining({ gate: "artifact-mutation" }),
			}),
		)
	})

	it("rejects a mutation of an artifact while the task is BLOCKED", async () => {
		mockResolve.mockResolvedValue({ status: "BLOCKED" })
		mockTask.assistantMessageContent = [writeToFileBlock(".roo/tasks/fix-01/README.md")]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockWriteToFileHandle).not.toHaveBeenCalled()
		expect(mockTask.userMessageContent[0].content).toContain("BLOCKED")
	})

	it("allows a mutation of an artifact while the task is in IMPLEMENTATION", async () => {
		mockResolve.mockResolvedValue({ status: "IMPLEMENTATION" })
		mockTask.assistantMessageContent = [writeToFileBlock(".roo/tasks/fix-01/implementation/T01-x.md")]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockWriteToFileHandle).toHaveBeenCalledTimes(1)
		expect(mockTask.userMessageContent).toHaveLength(0)
	})

	it("allows a mutation outside the artifacts root while the task is on PLAN_READY", async () => {
		mockResolve.mockResolvedValue({ status: "PLAN_READY" })
		mockTask.assistantMessageContent = [writeToFileBlock("src/core/task/Task.ts")]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockWriteToFileHandle).toHaveBeenCalledTimes(1)
		expect(mockTask.userMessageContent).toHaveLength(0)
	})

	it("allows a mutation when the task has no harness context", async () => {
		mockTask.getTaskContext = vi.fn().mockRejectedValue(new Error("no harness context"))
		mockTask.assistantMessageContent = [writeToFileBlock(".roo/tasks/fix-01/implementation/T01-x.md")]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockWriteToFileHandle).toHaveBeenCalledTimes(1)
		expect(mockTask.userMessageContent).toHaveLength(0)
	})

	it("rejects an apply_patch targeting an artifact while the task is on PLAN_READY", async () => {
		mockResolve.mockResolvedValue({ status: "PLAN_READY" })
		mockTask.assistantMessageContent = [applyPatchBlock(".roo/tasks/fix-01/implementation/T01-x.md")]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockApplyPatchHandle).not.toHaveBeenCalled()
		expect(mockTask.userMessageContent[0].content).toContain("PLAN_READY")
	})

	it("allows an apply_patch targeting an artifact while the task is in IMPLEMENTATION", async () => {
		mockResolve.mockResolvedValue({ status: "IMPLEMENTATION" })
		mockTask.assistantMessageContent = [applyPatchBlock(".roo/tasks/fix-01/implementation/T01-x.md")]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockApplyPatchHandle).toHaveBeenCalledTimes(1)
		expect(mockTask.userMessageContent).toHaveLength(0)
	})

	// ===== Unit-mutation gate (delegated stage child) =====

	const assignedArtifact = `${TASK_ROOT}/implementation/T05-stage-gates-extension.md`

	it("rejects a delegated stage child mutating another unit during IMPLEMENTATION", async () => {
		mockTask.parentTaskId = "parent-1"
		mockResolve.mockResolvedValue({ status: "IMPLEMENTATION", currentTaskArtifact: assignedArtifact })
		mockTask.assistantMessageContent = [writeToFileBlock(".roo/tasks/fix-01/implementation/T07-other.md")]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockWriteToFileHandle).not.toHaveBeenCalled()
		expect(mockTask.userMessageContent[0].content).toContain("another unit")
		expect(mockEvent).toHaveBeenCalledWith(
			"harness.gate.rejected",
			expect.objectContaining({
				level: "warn",
				attributes: expect.objectContaining({ gate: "unit-mutation" }),
			}),
		)
	})

	it("allows a delegated stage child mutating its assigned unit", async () => {
		mockTask.parentTaskId = "parent-1"
		mockResolve.mockResolvedValue({ status: "IMPLEMENTATION", currentTaskArtifact: assignedArtifact })
		mockTask.assistantMessageContent = [
			writeToFileBlock(".roo/tasks/fix-01/implementation/T05-stage-gates-extension.md"),
		]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockWriteToFileHandle).toHaveBeenCalledTimes(1)
		expect(mockTask.userMessageContent).toHaveLength(0)
	})

	it("allows a root task to mutate any unit during IMPLEMENTATION", async () => {
		mockResolve.mockResolvedValue({ status: "IMPLEMENTATION", currentTaskArtifact: null })
		mockTask.assistantMessageContent = [writeToFileBlock(".roo/tasks/fix-01/implementation/T07-other.md")]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockWriteToFileHandle).toHaveBeenCalledTimes(1)
		expect(mockTask.userMessageContent).toHaveLength(0)
	})
})
