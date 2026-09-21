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
	MODE_STATUSES,
	STAGE_RESULTS,
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
		...overrides,
	}
}

describe("LifecycleController", () => {
	it.each([
		["ANALYSIS", "architect", "COMPLETED", { type: "schedule_implementation", status: "READY_FOR_IMPLEMENTATION" }],
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
			{ type: "start_mode", status: "REFACTOR", mode: "code", failure: { key: null, attempts: 1 } },
		],
		["READY_FOR_REVIEW", "reviewer", "PASSED", { type: "start_mode", status: "REVIEW_PASSED", mode: "qa" }],
		[
			"READY_FOR_REVIEW",
			"reviewer",
			"REQUIRED",
			{ type: "start_mode", status: "REVIEW", mode: "code", failure: { key: null, attempts: 1 } },
		],
		["REVIEW", "reviewer", "PASSED", { type: "start_mode", status: "REVIEW_PASSED", mode: "qa" }],
		["REVIEW_PASSED", "qa", "PENDING", { type: "stop", status: "QA_READY", reason: "pending" }],
		["REVIEW_PASSED", "qa", "PASSED", { type: "stop", status: "DONE", reason: "done" }],
		[
			"REVIEW_PASSED",
			"qa",
			"FAILED",
			{ type: "start_mode", status: "QA_READY", mode: "code", failure: { key: null, attempts: 1 } },
		],
		["QA_READY", "qa", "PASSED", { type: "stop", status: "DONE", reason: "done" }],
	] as const)("maps %s + %s/%s without asking the model for the next mode", (status, mode, result, expected) => {
		const decision = controller.transition(state(status), { mode, result, failureKey: null })

		expect(decision).toEqual(expected)
	})

	it.each([
		["REVIEW", "READY_FOR_REVIEW", "reviewer"],
		["REFACTOR", "READY_FOR_REFACTOR", "refactor"],
		["QA_READY", "REVIEW_PASSED", "qa"],
	] as const)("routes a completed fix pass from %s back to the requesting stage", (status, target, mode) => {
		// The re-verification preserves whatever budget the fix pass had spent, so a
		// finding that comes back is counted against the same key.
		const source = state(status, { failureKey: "finding-a", failureAttempts: 2 })
		const decision = controller.transition(source, { mode: "code", result: "COMPLETED", failureKey: null })

		expect(decision).toEqual({
			type: "start_mode",
			status: target,
			mode,
			failure: { key: "finding-a", attempts: 2 },
		})
	})

	it("stops every stage when the model reports BLOCKED", () => {
		const decision = controller.transition(state("READY_FOR_REVIEW"), {
			mode: "reviewer",
			result: "BLOCKED",
			failureKey: null,
		})

		expect(decision).toEqual({ type: "stop", status: "BLOCKED", reason: "blocked" })
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
		const first = controller.transition(state("REVIEW", { failureKey: "finding-a", failureAttempts: 1 }), {
			mode: "reviewer",
			result: "REQUIRED",
			failureKey: "finding-a",
		})
		expect(first).toEqual({
			type: "start_mode",
			status: "REVIEW",
			mode: "code",
			failure: { key: "finding-a", attempts: 2 },
		})

		const other = controller.transition(state("REVIEW", { failureKey: "finding-a", failureAttempts: 2 }), {
			mode: "reviewer",
			result: "REQUIRED",
			failureKey: "finding-b",
		})
		expect(other).toEqual({
			type: "start_mode",
			status: "REVIEW",
			mode: "code",
			failure: { key: "finding-b", attempts: 1 },
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
			failure: { key: "finding-a", attempts: MAX_FAILURE_ATTEMPTS },
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
			failure: { key: null, attempts: 2 },
		})
	})

	it("resumes a task stopped at BLOCKED back into the implementation queue", () => {
		const decision = controller.resume(state("BLOCKED"), true)

		expect(decision).toEqual({ type: "resume_implementation", status: "READY_FOR_IMPLEMENTATION" })
		// The resume edge is canonical, so the status the runner writes is reachable.
		expect(isTaskStatusTransition("BLOCKED", "READY_FOR_IMPLEMENTATION")).toBe(true)
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
	it("advances ANALYSIS to implementation when the analysis artifacts are ready", () => {
		const decision = controller.resolve({
			state: state("ANALYSIS"),
			artifacts: artifacts(2),
			report: validationReport(),
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
	] as const)("keeps ANALYSIS on the architect stage for %s", (_label, report, taskCount) => {
		const decision = controller.resolve({ state: state("ANALYSIS"), artifacts: artifacts(taskCount), report })

		expect(decision).toEqual({
			type: "invalid",
			reason: "analysis artifacts are not ready; the architect stage must run",
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
