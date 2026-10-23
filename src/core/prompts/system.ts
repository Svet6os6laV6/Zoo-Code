import * as path from "path"
import * as vscode from "vscode"

import {
	type ModeConfig,
	type PromptComponent,
	type CustomModePrompts,
	type TodoItem,
	type ModelInfo,
} from "@roo-code/types"
import { formatArtifactValidationIssues, harnessLogger, redactPrompt } from "@roo-code/core"

import { Mode, modes, defaultModeSlug, getModeBySlug, getModeSelection } from "../../shared/modes"
import { DiffStrategy } from "../../shared/tools"
import { formatLanguage } from "../../shared/language"
import { isEmpty } from "../../utils/object"

import { McpHub } from "../../services/mcp/McpHub"
import { CodeIndexManagerRegistry } from "../../services/code-index/code-index-manager-registry"
import { SkillsManager } from "../../services/skills/SkillsManager"

import type { SystemPromptSettings } from "./types"
import { resolveEffectiveToolPolicy } from "./tools/effective-tool-policy"
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
	_supportsComputerUse: boolean,
	mode: Mode,
	mcpHub?: McpHub,
	_diffStrategy?: DiffStrategy,
	promptComponent?: PromptComponent,
	customModeConfigs?: ModeConfig[],
	globalCustomInstructions?: string,
	experiments?: Record<string, boolean>,
	language?: string,
	rooIgnoreInstructions?: string,
	settings?: SystemPromptSettings,
	_todoList?: TodoItem[],
	modelId?: string,
	skillsManager?: SkillsManager,
	disabledTools?: string[],
	modelInfo?: ModelInfo,
): Promise<string> {
	if (!context) {
		throw new Error("Extension context is required for generating system prompt")
	}

	const { roleDefinition, baseInstructions } = getModeSelection(mode, promptComponent, customModeConfigs)

	const codeIndexManager = CodeIndexManagerRegistry.getOrCreate(context, cwd)

	// Resolve the single, request-scoped effective tool policy ONCE, then have every
	// prompt section and the MCP short-circuit derive from it. This is the one source of
	// truth shared by prompt generation, API tool construction, runtime validation, and
	// preview, so the prose never advertises a tool the model cannot actually call.
	const policy = resolveEffectiveToolPolicy({
		mode,
		customModes: customModeConfigs,
		mcpHub,
		disabledTools,
		modelInfo,
		experiments,
		todoListEnabled: settings?.todoListEnabled,
		codeIndexManager,
	})

	const [modesSection, skillsSection] = await Promise.all([
		getModesSection(context),
		getSkillsSection(skillsManager, mode as string, policy),
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

${getToolUseGuidelinesSection(policy)}

${getCapabilitiesSection(policy)}

${modesSection}
${skillsSection ? `\n${skillsSection}` : ""}
${getRulesSection(cwd, settings, policy)}

${getSystemInfoSection(cwd, policy)}

${getObjectiveSection(policy)}

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
	disabledTools?: string[],
	modelInfo?: ModelInfo,
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
		disabledTools,
		modelInfo,
	)
}
