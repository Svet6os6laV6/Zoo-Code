import { TaskStateResolver, type TaskStatus } from "@roo-code/core"

import type { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import type { PlanApprovalOutcome } from "../harness/plan-approval"

import { BaseTool, ToolCallbacks } from "./BaseTool"

/**
 * Parameters for the `approve_plan` tool. `reason` is optional: it is shown with
 * the approval request and is not interpreted by the harness.
 */
interface ApprovePlanParams {
	reason?: string
}

export class ApprovePlanTool extends BaseTool<"approve_plan"> {
	readonly name = "approve_plan" as const

	/**
	 * Approve the plan of the executing task (harness-owned `PLAN_READY` exit).
	 *
	 * The tool is only the explicit signal: the harness still decides, through
	 * `ClineProvider.approvePlanForTask` → `HarnessModeRunner.approvePlan`, whether
	 * the task may leave `PLAN_READY`. The two guards below are guards, not model
	 * errors — they do not touch `consecutiveMistakeCount` or `recordToolError`
	 * (mirrors the `new_task` launch gate).
	 */
	async execute(params: ApprovePlanParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		const reason = params?.reason?.trim() || undefined

		try {
			const status = await this.resolveStatus(task)

			// Fails closed: unlike the launch gate (a no-op without a harness
			// context), approval must not proceed unless `PLAN_READY` is proven.
			if (status === null) {
				pushToolResult(
					formatResponse.toolError(
						"Could not read the canonical task state; the plan was not approved and nothing changed.",
					),
				)
				return
			}

			if (status !== "PLAN_READY") {
				pushToolResult(
					formatResponse.toolError(
						`The task is not waiting for plan approval (status: ${status}); nothing to approve. ` +
							"Plan approval is only possible from the harness-owned PLAN_READY gate.",
					),
				)
				return
			}

			const provider = task.providerRef.deref()

			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// The ordinary tool-approval flow is where the user consents to the
			// approval itself; the provider method therefore asks for no second,
			// modal confirmation (see `approvePlanForTask`).
			const toolMessage = JSON.stringify({
				tool: "approvePlan",
				content:
					"Approve the plan for this task? The harness will recompute the implementation DAG " +
					"and start the first ready unit.",
				...(reason && { reason }),
			})

			if (!(await askApproval("tool", toolMessage))) {
				return
			}

			pushToolResult(this.describeOutcome(await provider.approvePlanForTask(task)))
		} catch (error) {
			await handleError("approving the plan", error)
		}
	}

	/**
	 * Canonical status of the executing task, or `null` when it cannot be read.
	 */
	private async resolveStatus(task: Task): Promise<TaskStatus | null> {
		try {
			const context = await task.getTaskContext()

			return (await new TaskStateResolver().resolve(context)).status
		} catch {
			return null
		}
	}

	/** What the harness did, phrased for the model that asked for the approval. */
	private describeOutcome(outcome: PlanApprovalOutcome): string {
		if (!outcome.approved) {
			return formatResponse.toolError(outcome.reason ?? "The harness did not approve the plan.")
		}

		const next = outcome.currentTask
			? `The harness assigned implementation unit ${outcome.currentTask} and started its Code stage.`
			: "No implementation unit is assigned; the harness started the next stage."

		return (
			`Plan approved (status: ${outcome.status}). ${next} ` +
			"The lifecycle continues on its own (remaining units → Refactor → Reviewer → QA)."
		)
	}
}

export const approvePlanTool = new ApprovePlanTool()
