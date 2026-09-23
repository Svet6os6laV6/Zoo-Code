// npx vitest core/assistant-message/__tests__/presentAssistantMessage-harness-tool-call.spec.ts

import type { Anthropic } from "@anthropic-ai/sdk"
import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import type { Task } from "../../task/Task"

const mockHarnessEvent = vi.hoisted(() => vi.fn())

// Mock dependencies
vi.mock("../../task/Task")
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
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
		},
	},
}))
vi.mock("@roo-code/core", () => ({
	customToolRegistry: {
		has: vi.fn(() => false),
		get: vi.fn(),
	},
	harnessLogger: () => ({
		event: mockHarnessEvent,
	}),
}))

interface MockTask {
	taskId: string
	instanceId: string
	abort: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	currentStreamingContentIndex: number
	assistantMessageContent: unknown[]
	userMessageContent: Anthropic.ToolResultBlockParam[]
	didCompleteReadingStream: boolean
	didRejectTool: boolean
	didAlreadyUseTool: boolean
	consecutiveMistakeCount: number
	clineMessages: unknown[]
	api: { getModel: () => { id: string; info: Record<string, unknown> } }
	recordToolUsage: ReturnType<typeof vi.fn>
	recordToolError: ReturnType<typeof vi.fn>
	getTaskMode: ReturnType<typeof vi.fn>
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

describe("presentAssistantMessage - harness.tool.call emission", () => {
	let mockTask: MockTask

	beforeEach(() => {
		vi.clearAllMocks()

		mockTask = {
			taskId: "test-task-id",
			instanceId: "test-instance",
			abort: false,
			presentAssistantMessageLocked: false,
			presentAssistantMessageHasPendingUpdates: false,
			currentStreamingContentIndex: 0,
			assistantMessageContent: [],
			userMessageContent: [],
			didCompleteReadingStream: false,
			didRejectTool: false,
			didAlreadyUseTool: false,
			consecutiveMistakeCount: 0,
			clineMessages: [],
			api: {
				getModel: () => ({ id: "test-model", info: {} }),
			},
			recordToolUsage: vi.fn(),
			recordToolError: vi.fn(),
			getTaskMode: vi.fn().mockResolvedValue("code"),
			getHarnessLogContext: vi.fn().mockResolvedValue({ taskId: "test-task-id", traceId: "trace-1" }),
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

	it("emits no harness.tool.call for partial block representations", async () => {
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "tool_call_partial_123",
				name: "read_file",
				params: { path: "test.txt" },
				partial: true,
			},
		]

		// Simulate several streaming chunks for the same partial block.
		for (let i = 0; i < 3; i++) {
			await presentAssistantMessage(mockTask as unknown as Task)
		}

		expect(mockHarnessEvent).not.toHaveBeenCalled()
	})

	it("emits exactly one harness.tool.call for a completed block", async () => {
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "tool_call_complete_123",
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockHarnessEvent).toHaveBeenCalledTimes(1)
		expect(mockHarnessEvent).toHaveBeenCalledWith(
			"harness.tool.call",
			expect.objectContaining({
				attributes: expect.objectContaining({
					tool: "read_file",
					partial: false,
					durationMs: expect.any(Number),
				}),
			}),
		)

		const attributes = mockHarnessEvent.mock.calls[0][1].attributes
		expect(Number.isFinite(attributes.durationMs)).toBe(true)
		expect(attributes.durationMs).toBeGreaterThanOrEqual(0)
	})
})
