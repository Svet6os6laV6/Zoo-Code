import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import {
	buildSkillApprovalMessage,
	buildSkillResult,
	resolveSkillContentForMode,
} from "../../services/skills/skillInvocation"

interface SkillParams {
	skill: string
	args?: string
}

export class SkillTool extends BaseTool<"skill"> {
	readonly name = "skill" as const

	async execute(params: SkillParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { skill: skillName, args } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			// Validate skill name parameter
			if (!skillName) {
				task.consecutiveMistakeCount++
				task.recordToolError("skill")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("skill", "skill"))
				return
			}

			task.consecutiveMistakeCount = 0

			// Get SkillsManager from provider
			const provider = task.providerRef.deref()
			const skillsManager = provider?.getSkillsManager()

			if (!skillsManager) {
				task.recordToolError("skill")
				task.didToolFailInCurrentTurn = true
				pushToolResult(formatResponse.toolError("Skills Manager not available"))
				return
			}

			// Resolve skills against the task's own mode, not the provider's global mode:
			// a delegated subtask runs in its own mode while provider state still reflects
			// the parent task, which would misresolve skill availability.
			const currentMode = await task.getTaskMode()

			// Fetch skill content
			const skillContent = await resolveSkillContentForMode(skillsManager, skillName, currentMode)

			if (!skillContent) {
				const allowedModes = Array.from(
					new Set(
						skillsManager
							.getSkillsMetadata()
							.filter((skill) => skill.name === skillName)
							.flatMap((skill) => skill.modeSlugs ?? []),
					),
				).sort()

				// Get available skills for error message
				const availableSkills = skillsManager.getSkillsForMode(currentMode)
				const skillNames = availableSkills.map((s) => s.name)

				task.recordToolError("skill")
				task.didToolFailInCurrentTurn = true
				const error =
					allowedModes.length > 0
						? `Skill '${skillName}' is unavailable in ${currentMode} mode. It is available in: ${allowedModes.join(", ")}. Switch mode or delegate with new_task before invoking it.`
						: `Skill '${skillName}' not found. Available skills: ${skillNames.join(", ") || "(none)"}`

				pushToolResult(formatResponse.toolError(error))
				return
			}

			// Build approval message
			const toolMessage = buildSkillApprovalMessage(skillName, args, skillContent)

			const didApprove = await askApproval("tool", toolMessage)

			if (!didApprove) {
				return
			}

			pushToolResult(buildSkillResult(skillName, args, skillContent))
		} catch (error) {
			await handleError("executing skill", error as Error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"skill">): Promise<void> {
		const skillName: string | undefined = block.params.skill
		const args: string | undefined = block.params.args

		const partialMessage = JSON.stringify({
			tool: "skill",
			skill: skillName,
			args: args,
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const skillTool = new SkillTool()
