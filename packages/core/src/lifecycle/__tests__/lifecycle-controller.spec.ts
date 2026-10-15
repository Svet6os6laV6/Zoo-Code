import type {
	ArtifactValidationIssue,
	ArtifactValidationReport,
	ImplementationArtifacts,
} from "../../worktree/index.js"
import { TASK_STATUSES, isTaskStatusTransition, type TaskState } from "../../worktree/task-state.js"
import {
	LIFECYCLE_MODES,
	LifecycleController,
	MAX_FAILURE_ATTEMPTS,
	MAX_TOTAL_FAILURE_ATTEMPTS,
	MODE_STATUSES,
	STAGE_ENTRY_MODES,
	STAGE_RESULTS,
	STAGE_SUCCESS_RESULTS,
	parseStageOutcome,
} from "../index.js"

const controller = new LifecycleController()

function state(status: TaskState["status"], overrides: Partial<TaskState> = {}): TaskState {
	return {
		taskId: "SITESUP-1116",
		status,
		currentTask: null,
		currentTaskArtifact: null,
		failureKey: null,
		failureAttempts: 0,
		totalFailureAttempts: 0,
		blockedFrom: null,
		...overrides,
	}
}

describe("LifecycleController", () => {
	it.each([
		// The default gate stops a completed analysis at the approval gate instead of
		// handing straight to Code.
		["ANALYSIS", "sublimation", "COMPLETED", { type: "stop", status: "PLAN_READY", reason: "plan-approval" }],
		[
			"IMPLEMENTATION",
			"code",
			"COMPLETED",
			{ type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" },
		],
		[
			"IMPLEMENTATION",
			"code",
			"RESCHEDULE_REQUIRED",
			{ type: "reschedule_implementation", status: "READY_FOR_IMPLEMENTATION" },
		],
		[
			"READY_FOR_REFACTOR",
			"refactor",
			"COMPLETED",
			{ type: "start_mode", status: "READY_FOR_REVIEW", mode: "reviewer" },
		],
		["REFACTOR", "refactor", "COMPLETED", { type: "start_mode", status: "READY_FOR_REVIEW", mode: "reviewer" }],
		[
			"READY_FOR_REFACTOR",
			"refactor",
			"FUNCTIONAL_DEFECT",
			{ type: "start_mode", status: "REFACTOR", mode: "code", failure: { key: null, attempts: 1, total: 1 } },
		],
		["READY_FOR_REVIEW", "reviewer", "PASSED", { type: "start_mode", status: "REVIEW_PASSED", mode: "qa" }],
		[
			"READY_FOR_REVIEW",
			"reviewer",
			"REQUIRED",
			{ type: "start_mode", status: "REVIEW", mode: "code", failure: { key: null, attempts: 1, total: 1 } },
		],
		["REVIEW", "reviewer", "PASSED", { type: "start_mode", status: "REVIEW_PASSED", mode: "qa" }],
		["REVIEW_PASSED", "qa", "PENDING", { type: "stop", status: "QA_READY", reason: "pending" }],
		["REVIEW_PASSED", "qa", "PASSED", { type: "stop", status: "DONE", reason: "done" }],
		[
			"REVIEW_PASSED",
			"qa",
			"FAILED",
			{ type: "start_mode", status: "QA_READY", mode: "code", failure: { key: null, attempts: 1, total: 1 } },
		],
		["QA_READY", "qa", "PASSED", { type: "stop", status: "DONE", reason: "done" }],
	] as const)("maps %s + %s/%s without asking the model for the next mode", (status, mode, result, expected) => {
		const decision = controller.transition(state(status), { mode, result, failureKey: null })

		expect(decision).toEqual(expected)
	})

	it("schedules implementation from a completed analysis when the approval gate is off", () => {
		const decision = controller.transition(
			state("ANALYSIS"),
			{ mode: "sublimation", result: "COMPLETED", failureKey: null },
			{ requirePlanApproval: false },
		)

		expect(decision).toEqual({ type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" })
	})

	it("ignores the approval gate for every mode but sublimation", () => {
		// A fix pass or an implementation unit is not the plan stage, so the gate
		// must not alter their routing.
		const decision = controller.transition(
			state("IMPLEMENTATION"),
			{ mode: "code", result: "COMPLETED", failureKey: null },
			{ requirePlanApproval: true },
		)

		expect(decision).toEqual({ type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" })
	})

	it.each([
		["REVIEW", "READY_FOR_REVIEW", "reviewer"],
		["REFACTOR", "READY_FOR_REFACTOR", "refactor"],
		["QA_READY", "REVIEW_PASSED", "qa"],
	] as const)("routes a completed fix pass from %s back to the requesting stage", (status, target, mode) => {
		// The re-verification preserves whatever budget the fix pass had spent, so a
		// finding that comes back is counted against the same key.
		const source = state(status, { failureKey: "finding-a", failureAttempts: 2, totalFailureAttempts: 2 })
		const decision = controller.transition(source, { mode: "code", result: "COMPLETED", failureKey: null })

		expect(decision).toEqual({
			type: "start_mode",
			status: target,
			mode,
			failure: { key: "finding-a", attempts: 2, total: 2 },
		})
	})

	it("stops every stage when the model reports BLOCKED", () => {
		const decision = controller.transition(state("READY_FOR_REVIEW"), {
			mode: "reviewer",
			result: "BLOCKED",
			failureKey: null,
		})

		expect(decision).toEqual({
			type: "stop",
			status: "BLOCKED",
			reason: "blocked",
			blockedFrom: "READY_FOR_REVIEW",
		})
	})

	it("rejects RESCHEDULE_REQUIRED from a fix pass, which is not in the DAG", () => {
		// A fix pass runs from the requesting stage's marker, so it has no assigned
		// unit to re-queue; only an assigned implementation unit can reschedule.
		const decision = controller.transition(state("REVIEW"), {
			mode: "code",
			result: "RESCHEDULE_REQUIRED",
			failureKey: null,
		})

		expect(decision).toEqual({
			type: "invalid",
			reason: "Stage result RESCHEDULE_REQUIRED is not supported for mode code",
		})
	})

	it("rejects RESCHEDULE_REQUIRED from a stage that owns no implementation unit", () => {
		const decision = controller.transition(state("READY_FOR_REVIEW"), {
			mode: "reviewer",
			result: "RESCHEDULE_REQUIRED",
			failureKey: null,
		})

		expect(decision).toEqual({
			type: "invalid",
			reason: "Stage result RESCHEDULE_REQUIRED is not supported for mode reviewer",
		})
	})

	it("rejects an outcome from a mode that does not own the current stage", () => {
		const decision = controller.transition(state("REVIEW"), { mode: "qa", result: "PASSED", failureKey: null })

		expect(decision).toEqual({
			type: "invalid",
			reason: "Mode qa cannot complete lifecycle status REVIEW",
		})
	})

	it("rejects a mode that only claims a stage marker it does not own", () => {
		const decision = controller.transition(state("DONE"), { mode: "code", result: "COMPLETED", failureKey: null })

		expect(decision).toEqual({
			type: "invalid",
			reason: "Mode code cannot complete lifecycle status DONE",
		})
	})

	/**
	 * The drift guard for the two halves of the model: whatever a stage combo
	 * decides, the status it writes must already be legal in the canonical README
	 * status machine (or be a no-op rewrite of the status the task is already in).
	 */
	it("only ever writes canonical task status transitions", () => {
		const violations: string[] = []

		for (const status of TASK_STATUSES) {
			for (const mode of LIFECYCLE_MODES) {
				for (const result of STAGE_RESULTS) {
					const decision = controller.transition(state(status), { mode, result, failureKey: null })
					if (
						decision.type !== "start_mode" &&
						decision.type !== "stop" &&
						decision.type !== "reschedule_implementation"
					) {
						continue
					}

					const canonical = decision.status === status || isTaskStatusTransition(status, decision.status)
					if (!canonical) {
						violations.push(`${status} -> ${decision.status} decided by ${mode}/${result}`)
					}
				}
			}
		}

		expect(violations).toEqual([])
	})

	/**
	 * The other half of the drift guard: a status a mode claims must actually be
	 * routable. A stage/status pair that only ever produces `invalid` would silently
	 * fall back to the legacy resume path for every real outcome.
	 */
	it("claims only stage/status pairs that can actually be routed", () => {
		const meaningfulResults = STAGE_RESULTS.filter((result) => result !== "BLOCKED")
		const unroutable: string[] = []

		for (const mode of LIFECYCLE_MODES) {
			for (const status of MODE_STATUSES[mode]) {
				const routable = meaningfulResults.some(
					(result) =>
						controller.transition(state(status), { mode, result, failureKey: null }).type !== "invalid",
				)

				if (!routable) {
					unroutable.push(`${mode} cannot route any outcome from ${status}`)
				}
			}
		}

		expect(unroutable).toEqual([])
	})

	it("counts fix passes per failure key and resets when the key changes", () => {
		const first = controller.transition(
			state("REVIEW", { failureKey: "finding-a", failureAttempts: 1, totalFailureAttempts: 1 }),
			{
				mode: "reviewer",
				result: "REQUIRED",
				failureKey: "finding-a",
			},
		)
		expect(first).toEqual({
			type: "start_mode",
			status: "REVIEW",
			mode: "code",
			failure: { key: "finding-a", attempts: 2, total: 2 },
		})

		const other = controller.transition(
			state("REVIEW", { failureKey: "finding-a", failureAttempts: 2, totalFailureAttempts: 2 }),
			{
				mode: "reviewer",
				result: "REQUIRED",
				failureKey: "finding-b",
			},
		)
		expect(other).toEqual({
			type: "start_mode",
			status: "REVIEW",
			mode: "code",
			failure: { key: "finding-b", attempts: 1, total: 3 },
		})
	})

	it("stops at BLOCKED once a failure key exhausts its attempts", () => {
		const decision = controller.transition(
			state("REVIEW", { failureKey: "finding-a", failureAttempts: MAX_FAILURE_ATTEMPTS }),
			{ mode: "reviewer", result: "REQUIRED", failureKey: "finding-a" },
		)

		expect(decision).toEqual({
			type: "stop",
			status: "BLOCKED",
			reason: "max-attempts",
			failure: { key: "finding-a", attempts: MAX_FAILURE_ATTEMPTS, total: 1 },
			blockedFrom: "REVIEW",
		})
	})

	it("stops at BLOCKED once the episode budget is exhausted across keys", () => {
		// Relabelling the same finding resets the per-key counter but not the
		// total, so the global budget holds even against key churn.
		const decision = controller.transition(
			state("REVIEW", {
				failureKey: "finding-a",
				failureAttempts: 1,
				totalFailureAttempts: MAX_TOTAL_FAILURE_ATTEMPTS,
			}),
			{ mode: "reviewer", result: "REQUIRED", failureKey: "finding-b" },
		)

		expect(decision).toEqual({
			type: "stop",
			status: "BLOCKED",
			reason: "max-total-attempts",
			failure: {
				key: "finding-b",
				attempts: 1,
				total: MAX_TOTAL_FAILURE_ATTEMPTS,
			},
			blockedFrom: "REVIEW",
		})
	})

	it("carries the key over when the stage names none, so an unnamed loop is bounded", () => {
		const decision = controller.transition(state("REVIEW", { failureKey: null, failureAttempts: 1 }), {
			mode: "reviewer",
			result: "REQUIRED",
			failureKey: null,
		})

		expect(decision).toEqual({
			type: "start_mode",
			status: "REVIEW",
			mode: "code",
			failure: { key: null, attempts: 2, total: 1 },
		})
	})

	it("resumes a task stopped at BLOCKED back into the implementation queue", () => {
		const decision = controller.resume(state("BLOCKED"), true)

		expect(decision).toEqual({ type: "resume_implementation", status: "READY_FOR_IMPLEMENTATION" })
		// The resume edge is canonical, so the status the runner writes is reachable.
		expect(isTaskStatusTransition("BLOCKED", "READY_FOR_IMPLEMENTATION")).toBe(true)
	})

	it.each([
		["ANALYSIS", "ANALYSIS", "sublimation"],
		["READY_FOR_REFACTOR", "READY_FOR_REFACTOR", "refactor"],
		["READY_FOR_REVIEW", "READY_FOR_REVIEW", "reviewer"],
		["REVIEW_PASSED", "REVIEW_PASSED", "qa"],
	] as const)("resumes a task blocked at its %s stage entry back into that stage", (origin, target, mode) => {
		const decision = controller.resume(state("BLOCKED", { blockedFrom: origin }), true)

		expect(decision).toEqual({ type: "start_mode", status: target, mode })
		// The resume edge is canonical, so the status the runner writes is reachable.
		expect(isTaskStatusTransition("BLOCKED", target)).toBe(true)
	})

	it.each([
		["REFACTOR", "READY_FOR_REFACTOR", "refactor"],
		["REVIEW", "READY_FOR_REVIEW", "reviewer"],
		["QA_READY", "REVIEW_PASSED", "qa"],
	] as const)(
		"resumes a task blocked mid-fix-pass from %s as a re-verification with the budget preserved",
		(origin, target, mode) => {
			const decision = controller.resume(
				state("BLOCKED", {
					blockedFrom: origin,
					failureKey: "finding-a",
					failureAttempts: 2,
					totalFailureAttempts: 3,
				}),
				true,
			)

			expect(decision).toEqual({
				type: "start_mode",
				status: target,
				mode,
				failure: { key: "finding-a", attempts: 2, total: 3 },
			})
			expect(isTaskStatusTransition("BLOCKED", target)).toBe(true)
		},
	)

	it("resumes a task blocked from IMPLEMENTATION back into the implementation queue", () => {
		expect(controller.resume(state("BLOCKED", { blockedFrom: "IMPLEMENTATION" }), true)).toEqual({
			type: "resume_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})
	})

	it("refuses to resume to a corrupted blocked origin", () => {
		expect(controller.resume(state("BLOCKED", { blockedFrom: "DONE" }), true)).toEqual({
			type: "invalid",
			reason: "Cannot resume a task blocked from DONE",
		})
	})

	it("refuses to resume before the Unblock Condition is confirmed", () => {
		expect(controller.resume(state("BLOCKED"), false)).toEqual({
			type: "invalid",
			reason: "Resume requires the Unblock Condition to be confirmed",
		})
	})

	it("refuses to resume from any status other than BLOCKED", () => {
		expect(controller.resume(state("IMPLEMENTATION"), true)).toEqual({
			type: "invalid",
			reason: "Resume is only valid from BLOCKED, got IMPLEMENTATION",
		})
	})

	it("approves a plan at PLAN_READY and reopens the implementation queue", () => {
		const decision = controller.approvePlan(state("PLAN_READY"))

		expect(decision).toEqual({ type: "resume_implementation", status: "READY_FOR_IMPLEMENTATION" })
		// The approval edge is canonical, so the status the runner writes is reachable.
		expect(isTaskStatusTransition("PLAN_READY", "READY_FOR_IMPLEMENTATION")).toBe(true)
	})

	it.each(["ANALYSIS", "IMPLEMENTATION", "BLOCKED", "DONE"] as const)(
		"refuses to approve a plan from %s",
		(status) => {
			expect(controller.approvePlan(state(status))).toEqual({
				type: "invalid",
				reason: `Plan approval is only valid from PLAN_READY, got ${status}`,
			})
		},
	)

	it("confirms the QA outcome at QA_READY and finishes the task", () => {
		const decision = controller.approveQa(state("QA_READY"))

		expect(decision).toEqual({ type: "stop", status: "DONE", reason: "done" })
		// The confirmation edge is canonical, so the status the runner writes is reachable.
		expect(isTaskStatusTransition("QA_READY", "DONE")).toBe(true)
	})

	it.each(["REVIEW_PASSED", "ANALYSIS", "PLAN_READY", "IMPLEMENTATION", "BLOCKED", "DONE"] as const)(
		"refuses to confirm the QA outcome from %s",
		(status) => {
			expect(controller.approveQa(state(status))).toEqual({
				type: "invalid",
				reason: `QA confirmation is only valid from QA_READY, got ${status}`,
			})
		},
	)
})

function artifacts(taskCount: number): ImplementationArtifacts {
	return {
		directory: "/workspace/.roo/tasks/SITESUP-1116/implementation",
		missingDirectory: taskCount === 0,
		tasks: Array.from({ length: taskCount }, (_, index) => ({
			id: `T0${index + 1}`,
			fileName: `T0${index + 1}-unit.md`,
			artifact: `/workspace/.roo/tasks/SITESUP-1116/implementation/T0${index + 1}-unit.md`,
			status: "TODO" as const,
			statusProblem: null,
			dependsOn: [],
			parallelWith: [],
			produces: null,
			consumes: null,
			unclosedCodeFence: false,
			contentHash: "hash",
		})),
		duplicateIds: [],
		unexpectedFiles: [],
	}
}

function validationReport(issues: readonly ArtifactValidationIssue[] = []): ArtifactValidationReport {
	const errors = issues.filter((item) => item.severity === "error")
	const warnings = issues.filter((item) => item.severity === "warning")
	return { issues, errors, warnings, artifacts: artifacts(0), valid: errors.length === 0 }
}

function issue(
	severity: ArtifactValidationIssue["severity"],
	code: ArtifactValidationIssue["code"],
): ArtifactValidationIssue {
	return { severity, code, taskId: null, message: code }
}

describe("LifecycleController.resolve", () => {
	it("stops at PLAN_READY when the analysis artifacts are ready and the gate is on", () => {
		const decision = controller.resolve({
			state: state("ANALYSIS"),
			artifacts: artifacts(2),
			report: validationReport(),
		})

		expect(decision).toEqual({ type: "stop", status: "PLAN_READY", reason: "plan-approval" })
	})

	it("advances ANALYSIS to implementation when the gate is off", () => {
		const decision = controller.resolve({
			state: state("ANALYSIS"),
			artifacts: artifacts(2),
			report: validationReport(),
			requirePlanApproval: false,
		})

		expect(decision).toEqual({ type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" })
	})

	it.each([
		["a missing implementation plan", validationReport([issue("warning", "missing-implementation-plan")]), 2],
		[
			"a missing implementation directory",
			validationReport([issue("warning", "missing-implementation-directory")]),
			2,
		],
		["no parsed implementation unit", validationReport(), 0],
		["a structural error", validationReport([issue("error", "duplicate-task-id")]), 2],
	] as const)("keeps ANALYSIS on the sublimation stage for %s", (_label, report, taskCount) => {
		const decision = controller.resolve({ state: state("ANALYSIS"), artifacts: artifacts(taskCount), report })

		expect(decision).toEqual({
			type: "invalid",
			reason: "analysis artifacts are not ready; the sublimation stage must run",
		})
	})

	it.each(["READY_FOR_IMPLEMENTATION", "IMPLEMENTATION"] as const)(
		"continues the implementation DAG from %s",
		(status) => {
			const decision = controller.resolve({
				state: state(status),
				artifacts: artifacts(2),
				report: validationReport(),
			})

			expect(decision).toEqual({ type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" })
		},
	)

	it.each([
		["READY_FOR_REFACTOR", "refactor"],
		["READY_FOR_REVIEW", "reviewer"],
		["REVIEW_PASSED", "qa"],
	] as const)("starts the %s stage as a no-op self-loop", (status, mode) => {
		const decision = controller.resolve({
			state: state(status),
			artifacts: artifacts(2),
			report: validationReport(),
		})

		expect(decision).toEqual({ type: "start_mode", status, mode })
	})

	// Drift guard for `STAGE_ENTRY_MODES`: every entry must be exactly the set of
	// statuses whose state-only continue restarts that stage, so the restart
	// budget and the forced advance cannot route a status the controller does
	// not re-start.
	it.each(Object.entries(STAGE_ENTRY_MODES) as [TaskState["status"], keyof typeof STAGE_SUCCESS_RESULTS][])(
		"restarts the %s stage exactly as STAGE_ENTRY_MODES declares",
		(status, mode) => {
			const decision = controller.resolve({
				state: state(status),
				artifacts: artifacts(2),
				report: validationReport(),
			})

			expect(decision).toEqual({ type: "start_mode", status, mode })
		},
	)

	// Drift guard for `STAGE_SUCCESS_RESULTS`: a forced advance reports the
	// mode's success outcome through the ordinary transition, so the entry must
	// stay a result the controller actually routes for the mode's own status.
	it.each(Object.entries(STAGE_SUCCESS_RESULTS) as [keyof typeof MODE_STATUSES, (typeof STAGE_RESULTS)[number]][])(
		"force-advances %s canonically through its success result %s",
		(mode, result) => {
			const decision = controller.transition(state(MODE_STATUSES[mode][0]), { mode, result, failureKey: null })

			expect(decision.type).not.toBe("invalid")
		},
	)

	it.each(["REFACTOR", "REVIEW", "QA_READY"] as const)(
		"does not advance while a fix pass is in flight at %s",
		(status) => {
			const decision = controller.resolve({
				state: state(status),
				artifacts: artifacts(2),
				report: validationReport(),
			})

			expect(decision).toEqual({
				type: "invalid",
				reason: "a fix pass is in flight; the harness does not advance",
			})
		},
	)

	it("does not advance a DONE task", () => {
		expect(
			controller.resolve({ state: state("DONE"), artifacts: artifacts(2), report: validationReport() }),
		).toEqual({
			type: "invalid",
			reason: "task is done",
		})
	})

	it("leaves a BLOCKED task to the harness-owned resume action", () => {
		expect(
			controller.resolve({ state: state("BLOCKED"), artifacts: artifacts(2), report: validationReport() }),
		).toEqual({
			type: "invalid",
			reason: "task is blocked; resume is a harness-owned action",
		})
	})

	it("leaves a PLAN_READY task to the harness-owned approval action", () => {
		expect(
			controller.resolve({ state: state("PLAN_READY"), artifacts: artifacts(2), report: validationReport() }),
		).toEqual({
			type: "invalid",
			reason: "plan approval is a harness-owned action",
		})
	})

	/**
	 * The drift guard for `resolve`: whatever status it decides to write must
	 * already be legal in the canonical README status machine (or be a no-op
	 * rewrite of the status the task is already in).
	 */
	it("only ever writes canonical task status transitions", () => {
		const violations: string[] = []

		for (const status of TASK_STATUSES) {
			const decision = controller.resolve({
				state: state(status),
				artifacts: artifacts(2),
				report: validationReport(),
			})
			if (decision.type !== "start_mode" && decision.type !== "stop") {
				continue
			}

			if (decision.status !== status && !isTaskStatusTransition(status, decision.status)) {
				violations.push(`${status} -> ${decision.status}`)
			}
		}

		expect(violations).toEqual([])
	})
})

describe("parseStageOutcome", () => {
	it("reads the semantic result while deriving the mode from runtime state", () => {
		expect(parseStageOutcome("reviewer", "Review complete.\nStage Result: PASSED")).toEqual({
			mode: "reviewer",
			result: "PASSED",
			failureKey: null,
		})
	})

	it("tolerates trailing punctuation on the result token", () => {
		expect(parseStageOutcome("reviewer", "Review complete.\nStage Result: PASSED.")).toEqual({
			mode: "reviewer",
			result: "PASSED",
			failureKey: null,
		})
		expect(parseStageOutcome("code", "Stage Result: COMPLETED,\n")).toEqual({
			mode: "code",
			result: "COMPLETED",
			failureKey: null,
		})
	})

	it("parses a defensive NOT_APPLICABLE report and refuses to route it", () => {
		const outcome = parseStageOutcome("reviewer", "Stage Result: NOT_APPLICABLE")

		expect(outcome).toEqual({ mode: "reviewer", result: "NOT_APPLICABLE", failureKey: null })
		expect(
			controller.transition(state("READY_FOR_REVIEW"), {
				mode: "reviewer",
				result: "NOT_APPLICABLE",
				failureKey: null,
			}),
		).toEqual({
			type: "invalid",
			reason: "Stage result NOT_APPLICABLE is not a stage outcome; the harness routes from the canonical state",
		})
	})

	it("reads an optional failure key named by the stage", () => {
		expect(parseStageOutcome("reviewer", "Stage Result: REQUIRED\nFailure Key: auth-token-expiry")).toEqual({
			mode: "reviewer",
			result: "REQUIRED",
			failureKey: "auth-token-expiry",
		})
	})

	it("treats the canonical NONE sentinel as no failure key", () => {
		expect(parseStageOutcome("qa", "Stage Result: PASSED\nFailure Key: NONE")).toEqual({
			mode: "qa",
			result: "PASSED",
			failureKey: null,
		})
	})

	it("rejects a report that names more than one failure key", () => {
		expect(parseStageOutcome("reviewer", "Stage Result: REQUIRED\nFailure Key: a\nFailure Key: b")).toBeNull()
	})

	it("ignores model-controlled routing fields", () => {
		expect(parseStageOutcome("reviewer", "Stage Result: PASSED\nNext Mode: code")).toEqual({
			mode: "reviewer",
			result: "PASSED",
			failureKey: null,
		})
	})

	it("refuses an ambiguous report that declares the marker twice", () => {
		expect(parseStageOutcome("reviewer", "Stage Result: PASSED\nStage Result: FAILED")).toBeNull()
	})
})
