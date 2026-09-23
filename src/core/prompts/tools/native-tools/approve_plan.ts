import type OpenAI from "openai"

const APPROVE_PLAN_DESCRIPTION = `Approve the plan of the current task so the harness starts implementation.

Use this tool only while the task is waiting for plan approval — the canonical README status is PLAN_READY. That status is a harness-owned gate: no other tool leaves it, and no stage mode may be launched from it. This call is the explicit approval signal, issued by the orchestrator, that replaces the user's "Approve Plan" action.

After approval the harness recomputes the implementation DAG from disk, assigns the first ready unit and starts the Code stage. The rest of the lifecycle (remaining units → Refactor → Reviewer → QA → DONE) then continues without further prompting.

Call it once the plan is ready to be implemented. Calling it when the task is not at PLAN_READY changes nothing and returns an error explaining the current status.`

const REASON_PARAMETER_DESCRIPTION = `Optional short note describing why the plan is being approved; shown to the user with the approval request and not interpreted by the harness`

export default {
	type: "function",
	function: {
		name: "approve_plan",
		description: APPROVE_PLAN_DESCRIPTION,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				reason: {
					type: ["string", "null"],
					description: REASON_PARAMETER_DESCRIPTION,
				},
			},
			required: ["reason"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
