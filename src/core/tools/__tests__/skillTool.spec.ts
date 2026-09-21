import { describe, it, expect, vi, beforeEach } from "vitest"
import { skillTool } from "../SkillTool"
import { Task } from "../../task/Task"
import { formatResponse } from "../../prompts/responses"
import type { ToolUse } from "../../../shared/tools"

describe("skillTool", () => {
	let mockTask: any
	let mockCallbacks: any
	let mockSkillsManager: any

	beforeEach(() => {
		vi.clearAllMocks()

		mockSkillsManager = {
			getSkillContent: vi.fn(),
			getSkillsForMode: vi.fn().mockReturnValue([]),
			getSkillsMetadata: vi.fn().mockReturnValue([]),
		}

		mockTask = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			getTaskMode: vi.fn().mockResolvedValue("code"),
			didToolFailInCurrentTurn: false,
			sayAndCreateMissingParamError: vi.fn().mockResolvedValue("Missing parameter error"),
			ask: vi.fn().mockResolvedValue({}),
			providerRef: {
				deref: vi.fn().mockReturnValue({
					getState: vi.fn().mockResolvedValue({ mode: "code" }),
					getSkillsManager: vi.fn().mockReturnValue(mockSkillsManager),
				}),
			},
		}

		mockCallbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
	})

	it("should handle missing skill parameter", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "",
			},
		}

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(1)
		expect(mockTask.recordToolError).toHaveBeenCalledWith("skill")
		expect(mockTask.sayAndCreateMissingParamError).toHaveBeenCalledWith("skill", "skill")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith("Missing parameter error")
	})

	it("should handle skill not found", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "non-existent",
			},
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(null)
		mockSkillsManager.getSkillsForMode.mockReturnValue([{ name: "create-mcp-server" }])

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Skill 'non-existent' not found. Available skills: create-mcp-server"),
		)
	})

	it("should handle empty available skills list", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "non-existent",
			},
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(null)
		mockSkillsManager.getSkillsForMode.mockReturnValue([])

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Skill 'non-existent' not found. Available skills: (none)"),
		)
	})

	it("should direct mode-restricted skills to their allowed mode", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "qa-scope",
			},
		}

		// The task's own mode drives skill resolution, not provider state.
		mockTask.getTaskMode.mockResolvedValue("orchestrator")
		mockSkillsManager.getSkillContent.mockResolvedValue(null)
		mockSkillsManager.getSkillsMetadata.mockReturnValue([
			{ name: "qa-scope", modeSlugs: ["qa"], source: "project" },
		])

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError(
				"Skill 'qa-scope' is unavailable in orchestrator mode. It is available in: qa. " +
					"Switch mode or delegate with new_task before invoking it.",
			),
		)
	})

	it("resolves skills against the task mode even when provider state reports the parent's mode", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "qa-scope",
			},
		}

		// Provider state still reflects the orchestrator-mode parent...
		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({ mode: "orchestrator" }),
			getSkillsManager: vi.fn().mockReturnValue(mockSkillsManager),
		})
		// ...but the delegated subtask runs in code mode.
		mockTask.getTaskMode.mockResolvedValue("code")
		mockSkillsManager.getSkillContent.mockResolvedValue({
			name: "qa-scope",
			description: "QA scope",
			source: "project",
			instructions: "Do QA.",
		})

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		// The skill is resolved for the task's own mode, not the parent's.
		expect(mockSkillsManager.getSkillContent).toHaveBeenCalledWith("qa-scope", "code")
	})

	it("should successfully load a global skill", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		const mockSkillContent = {
			name: "create-mcp-server",
			description: "Instructions for creating MCP servers",
			source: "global",
			instructions: "Step 1: Create the server...",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "skill",
				skill: "create-mcp-server",
				args: undefined,
				source: "global",
				description: "Instructions for creating MCP servers",
			}),
		)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Skill: create-mcp-server
Description: Instructions for creating MCP servers
Source: global

--- Skill Instructions ---

Step 1: Create the server...`,
		)
	})

	it("should successfully load skill with arguments", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
				args: "weather API server",
			},
		}

		const mockSkillContent = {
			name: "create-mcp-server",
			description: "Instructions for creating MCP servers",
			source: "global",
			instructions: "Step 1: Create the server...",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Skill: create-mcp-server
Description: Instructions for creating MCP servers
Provided arguments: weather API server
Source: global

--- Skill Instructions ---

Step 1: Create the server...`,
		)
	})

	it("should handle user rejection", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		mockSkillsManager.getSkillContent.mockResolvedValue({
			name: "create-mcp-server",
			description: "Test",
			source: "global",
			instructions: "Test instructions",
		})

		mockCallbacks.askApproval.mockResolvedValue(false)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("should handle partial block", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {
				skill: "create-mcp-server",
				args: "",
			},
			partial: true,
		}

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.ask).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "skill",
				skill: "create-mcp-server",
				args: "",
			}),
			true,
		)

		expect(mockCallbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("should handle errors during execution", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		const error = new Error("Test error")
		mockSkillsManager.getSkillContent.mockRejectedValue(error)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.handleError).toHaveBeenCalledWith("executing skill", error)
	})

	it("should reset consecutive mistake count on valid skill", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		mockTask.consecutiveMistakeCount = 5

		const mockSkillContent = {
			name: "create-mcp-server",
			description: "Test",
			source: "global",
			instructions: "Test instructions",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.consecutiveMistakeCount).toBe(0)
	})

	it("should handle Skills Manager not available", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "create-mcp-server",
			},
		}

		mockTask.providerRef.deref = vi.fn().mockReturnValue({
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
		})

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockTask.recordToolError).toHaveBeenCalledWith("skill")
		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			formatResponse.toolError("Skills Manager not available"),
		)
	})

	it("should load project skill", async () => {
		const block: ToolUse<"skill"> = {
			type: "tool_use" as const,
			name: "skill" as const,
			params: {},
			partial: false,
			nativeArgs: {
				skill: "my-project-skill",
			},
		}

		const mockSkillContent = {
			name: "my-project-skill",
			description: "A custom project skill",
			source: "project",
			instructions: "Follow these project-specific instructions...",
		}

		mockSkillsManager.getSkillContent.mockResolvedValue(mockSkillContent)

		await skillTool.handle(mockTask as Task, block, mockCallbacks)

		expect(mockCallbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			JSON.stringify({
				tool: "skill",
				skill: "my-project-skill",
				args: undefined,
				source: "project",
				description: "A custom project skill",
			}),
		)

		expect(mockCallbacks.pushToolResult).toHaveBeenCalledWith(
			`Skill: my-project-skill
Description: A custom project skill
Source: project

--- Skill Instructions ---

Follow these project-specific instructions...`,
		)
	})
})
