import * as path from "path"
import * as vscode from "vscode"

import { type ModeConfig, type PromptComponent, type CustomModePrompts, type TodoItem } from "@roo-code/types"
import { formatArtifactValidationIssues, harnessLogger, redactPrompt } from "@roo-code/core"

import { Mode, modes, defaultModeSlug, getModeBySlug, getGroupName, getModeSelection } from "../../shared/modes"
import { DiffStrategy } from "../../shared/tools"
import { formatLanguage } from "../../shared/language"
import { isEmpty } from "../../utils/object"

import { McpHub } from "../../services/mcp/McpHub"
import { CodeIndexManager } from "../../services/code-index/manager"
import { SkillsManager } from "../../services/skills/SkillsManager"

import type { SystemPromptSettings } from "./types"
import {
	getRulesSection,
	getSystemInfoSection,
	getObjectiveSection,
	getSharedToolUseSection,
	getToolUseGuidelinesSection,
	getCapabilitiesSection,
	getModesSection,
	addCustomInstructions,
	markdownFormattingSection,
	getSkillsSection,
} from "./sections"

// Helper function to get prompt component, filtering out empty objects
export function getPromptComponent(
	customModePrompts: CustomModePrompts | undefined,
	mode: string,
): PromptComponent | undefined {
	const component = customModePrompts?.[mode]
	// Return undefined if component is empty
	if (isEmpty(component)) {
		return undefined
	}
	return component
}

async function generatePrompt(
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mode: Mode,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	promptComponent?: PromptComponent,
	customModeConfigs?: ModeConfig[],
	globalCustomInstructions?: string,
	experiments?: Record<string, boolean>,
	language?: string,
	rooIgnoreInstructions?: string,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	skillsManager?: SkillsManager,
): Promise<string> {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Get the full mode config to ensure we have the role definition (used for groups, etc.)
	const modeConfig = getModeBySlug(mode, customModeConfigs) || modes.find((m) => m.slug === mode) || modes[0]
	const { roleDefinition, baseInstructions } = getModeSelection(mode, promptComponent, customModeConfigs)

	// Check if MCP functionality should be included
	const hasMcpGroup = modeConfig.groups.some((groupEntry) => getGroupName(groupEntry) === "mcp")
	const allowedMcpServers = modeConfig.allowedMcpServers

	// Hoist the allowlist Set once (matches the sibling call sites, e.g. mcp_server.ts) instead
	// of constructing a new Set on every `.filter` iteration.
	const allowSet = allowedMcpServers ? new Set(allowedMcpServers) : undefined

	let hasMcpServers = false
	if (mcpHub) {
		const servers = allowSet ? mcpHub.getServers().filter((s) => allowSet.has(s.name)) : mcpHub.getServers()
		hasMcpServers = servers.length > 0
	}
	const shouldIncludeMcp = hasMcpGroup && hasMcpServers

	const codeIndexManager = CodeIndexManager.getInstance(context, cwd)

	// Tool calling is native-only.
	const effectiveProtocol = "native"

	const [modesSection, skillsSection] = await Promise.all([
		getModesSection(context),
		getSkillsSection(skillsManager, mode as string),
	])

	// Tools catalog is not included in the system prompt.
	const toolsCatalog = ""
	const taskContextLines = settings?.taskContext
		? [
				`Current task: ${settings.taskContext.taskId}`,
				`Task artifacts: ${path.relative(cwd, settings.taskContext.taskRoot).split(path.sep).join("/")}/`,
			]
		: []
	if (settings?.taskState) {
		taskContextLines.push(`Task status: ${settings.taskState.status}`)
		taskContextLines.push(`Implementation unit: ${settings.taskState.currentTask ?? "NONE"}`)
		if (settings.taskState.currentTaskArtifact) {
			taskContextLines.push(
				`Artifact: ${path.relative(cwd, settings.taskState.currentTaskArtifact).split(path.sep).join("/")}`,
			)
		}
	}
	const taskContextSection = taskContextLines.length > 0 ? `${taskContextLines.join("\n")}\n\n` : ""

	// Structural artifact problems are injected so the model repairs the artifacts
	// in the current session instead of guessing around them.
	const artifactValidationSection =
		settings?.artifactValidationIssues && settings.artifactValidationIssues.length > 0
			? `Artifact validation issues:\n${formatArtifactValidationIssues(settings.artifactValidationIssues)}\n\n`
			: ""

	const basePrompt = `${roleDefinition}

${taskContextSection}${artifactValidationSection}${markdownFormattingSection()}

${getSharedToolUseSection()}${toolsCatalog}

	${getToolUseGuidelinesSection()}

${
	// Forward the hub only when the mode actually exposes the MCP group, and pass the per-mode
	// allowlist through so the capabilities section filters servers using the SAME convention as
	// the tool-listing layer (a single source of truth for which servers are visible). This keeps
	// the capability text consistent with the tools exposed in mixed cases (e.g. one allowed +
	// one disallowed server), preventing the section from advertising MCP based on a disallowed
	// server. `shouldIncludeMcp` is still used to short-circuit when no allowed server exists.
	getCapabilitiesSection(cwd, hasMcpGroup ? mcpHub : undefined, allowedMcpServers)
}

${modesSection}
${skillsSection ? `\n${skillsSection}` : ""}
${getRulesSection(cwd, settings)}

${getSystemInfoSection(cwd)}

${getObjectiveSection()}

${await addCustomInstructions(baseInstructions, globalCustomInstructions || "", cwd, mode, {
	language: language ?? formatLanguage(vscode.env.language),
	rooIgnoreInstructions,
	settings,
})}`

	// Structured observability: the assembly metadata is always recorded, while the
	// full prompt is recorded only behind the `harnessLogFullPrompts` debug option
	// and always through the redactor.
	harnessLogger().event("harness.prompt.assemble", {
		context: {
			mode: mode as string,
			taskId: settings?.taskContext?.taskId ?? null,
			txxId: settings?.taskState?.currentTask ?? null,
		},
		attributes: {
			mode,
			modelId: modelId ?? null,
			promptLength: basePrompt.length,
			taskContextSectionLength: taskContextSection.length,
			artifactValidationSectionLength: artifactValidationSection.length,
			modesSectionLength: modesSection.length,
			skillsSectionLength: skillsSection.length,
			taskStatus: settings?.taskState?.status ?? null,
			artifactIssueCount: settings?.artifactValidationIssues?.length ?? 0,
			...(settings?.harnessLogFullPrompts ? { prompt: redactPrompt(basePrompt) } : {}),
		},
	})

	return basePrompt
}

export const SYSTEM_PROMPT = async (
	context: vscode.ExtensionContext,
	cwd: string,
	supportsComputerUse: boolean,
	mcpHub?: McpHub,
	diffStrategy?: DiffStrategy,
	mode: Mode = defaultModeSlug,
	customModePrompts?: CustomModePrompts,
	customModes?: ModeConfig[],
	globalCustomInstructions?: string,
	experiments?: Record<string, boolean>,
	language?: string,
	rooIgnoreInstructions?: string,
	settings?: SystemPromptSettings,
	todoList?: TodoItem[],
	modelId?: string,
	skillsManager?: SkillsManager,
): Promise<string> => {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	// Check if it's a custom mode
	const promptComponent = getPromptComponent(customModePrompts, mode)

	// Get full mode config from custom modes or fall back to built-in modes
	const currentMode = getModeBySlug(mode, customModes) || modes.find((m) => m.slug === mode) || modes[0]

	return generatePrompt(
		context,
		cwd,
		supportsComputerUse,
		currentMode.slug,
		mcpHub,
		diffStrategy,
		promptComponent,
		customModes,
		globalCustomInstructions,
		experiments,
		language,
		rooIgnoreInstructions,
		settings,
		todoList,
		modelId,
		skillsManager,
	)
}
