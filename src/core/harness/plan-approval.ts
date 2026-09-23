/**
 * The harness-owned plan-approval contract.
 *
 * `PLAN_READY` is a harness-owned gate: no stage outcome leaves it, no stage mode
 * runs there, and the model cannot route out of it. The only exit is the
 * harness's own `LifecycleController.approvePlan` → `resume_implementation`
 * decision, and the caller must already hold the user's approval when it invokes
 * it — either the "Approve Plan" action or the `approve_plan` tool call that went
 * through the ordinary tool-approval flow.
 *
 * This module holds the outcome both entry points report back, so the tool and
 * the provider share one definition instead of describing the same result twice.
 * Pure: a type only.
 */

import type { TaskStatus } from "@roo-code/core"

/** What the harness did with an approval request. */
export interface PlanApprovalOutcome {
	/** Whether the harness approved the plan. `false` ⇒ the task was left unchanged. */
	readonly approved: boolean
	/** Canonical status after the approval, or `null` when nothing was applied. */
	readonly status: TaskStatus | null
	/** The implementation unit the harness assigned (canonical `Current Task`), if any. */
	readonly currentTask: string | null
	/** Why the approval was not applied; `null` when it was. */
	readonly reason: string | null
}
