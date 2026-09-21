// npx vitest src/core/assistant-message/__tests__/presentAssistantMessage-task-mode.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import { presentAssistantMessage } from "../presentAssistantMessage"
import type { Task } from "../../task/Task"

// presentAssistantMessage records tool usage through TelemetryService.instance.
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
}))

/**
 * Regression coverage for the per-task ("sticky") mode model.
 *
 * A delegated subtask runs in its own mode while the provider's global mode still
 * reflects the parent task. Execution-time tool validation must therefore use the
 * task's own mode (`getTaskMode`), not `provider.getState().mode` — otherwise a
 * code-mode child of an orchestrator-mode parent has every tool rejected with
 * `Tool "read_file" is not allowed in orchestrator mode.`
 */
describe("presentAssistantMessage - task-local mode validation", () => {
	const createMockTask = (providerMode: string, taskMode: string) => ({
		taskId: "test-task-id",
		instanceId: "test-instance",
		abort: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		assistantMessageContent: [] as unknown[],
		userMessageContent: [] as unknown[],
		didCompleteReadingStream: false,
		didRejectTool: false,
		didAlreadyUseTool: false,
		consecutiveMistakeCount: 0,
		clineMessages: [] as unknown[],
		api: {
			getModel: () => ({ id: "test-model", info: {} }),
		},
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		getTaskMode: vi.fn().mockResolvedValue(taskMode),
		toolRepetitionDetector: {
			check: vi.fn().mockReturnValue({ allowExecution: true }),
		},
		providerRef: {
			deref: () => ({
				getState: vi.fn().mockResolvedValue({
					mode: providerMode,
					customModes: [],
				}),
			}),
		},
		say: vi.fn().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		pushToolResultToUserContent: vi.fn().mockReturnValue(true),
	})

	let mockTask: ReturnType<typeof createMockTask>

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("validates a delegated subtask's tools against the task mode, not the parent's provider mode", async () => {
		// Parent task is in orchestrator mode (groups: []); the child subtask runs in code mode.
		mockTask = createMockTask("orchestrator", "code")
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_read",
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		// The mock is a partial Task double; the double assertion is required because
		// presentAssistantMessage only reads the fields exercised above.
		await presentAssistantMessage(mockTask as unknown as Task)

		// Validation passed against the task's own mode, so the attempt is recorded...
		expect(mockTask.recordToolUsage).toHaveBeenCalledWith("read_file")
		// ...and no mode-restriction error is raised for the parent's mode.
		expect(mockTask.recordToolError).not.toHaveBeenCalledWith(
			"read_file",
			expect.stringContaining("not allowed in orchestrator mode"),
		)
	})

	it("still blocks tools that the task's own mode does not allow", async () => {
		// The task itself is in orchestrator mode: read_file must remain disallowed.
		mockTask = createMockTask("orchestrator", "orchestrator")
		mockTask.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call_read",
				name: "read_file",
				params: { path: "test.txt" },
				nativeArgs: { path: "test.txt" },
				partial: false,
			},
		]

		await presentAssistantMessage(mockTask as unknown as Task)

		expect(mockTask.recordToolError).toHaveBeenCalledWith(
			"read_file",
			expect.stringContaining("not allowed in orchestrator mode"),
		)
		expect(mockTask.recordToolUsage).not.toHaveBeenCalled()
	})
})
