import { TASK_STATUSES, isTaskStatusTransition, type TaskState } from "../../worktree/task-state.js"
import { LIFECYCLE_MODES, LifecycleController, MODE_STATUSES, STAGE_RESULTS, parseStageOutcome } from "../index.js"

const controller = new LifecycleController()

function state(status: TaskState["status"]): TaskState {
	return {
		taskId: "SITESUP-1116",
		status,
		currentTask: null,
		currentTaskArtifact: null,
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
			{ type: "start_mode", status: "REFACTOR", mode: "code" },
		],
		["READY_FOR_REVIEW", "reviewer", "PASSED", { type: "start_mode", status: "REVIEW_PASSED", mode: "qa" }],
		["READY_FOR_REVIEW", "reviewer", "REQUIRED", { type: "start_mode", status: "REVIEW", mode: "code" }],
		["REVIEW", "reviewer", "PASSED", { type: "start_mode", status: "REVIEW_PASSED", mode: "qa" }],
		["REVIEW_PASSED", "qa", "PENDING", { type: "stop", status: "QA_READY", reason: "pending" }],
		["REVIEW_PASSED", "qa", "PASSED", { type: "stop", status: "DONE", reason: "done" }],
		["REVIEW_PASSED", "qa", "FAILED", { type: "start_mode", status: "QA_READY", mode: "code" }],
		["QA_READY", "qa", "PASSED", { type: "stop", status: "DONE", reason: "done" }],
	] as const)("maps %s + %s/%s without asking the model for the next mode", (status, mode, result, expected) => {
		const decision = controller.transition(state(status), { mode, result })

		expect(decision).toEqual(expected)
	})

	it.each([
		["REVIEW", "READY_FOR_REVIEW", "reviewer"],
		["REFACTOR", "READY_FOR_REFACTOR", "refactor"],
		["QA_READY", "REVIEW_PASSED", "qa"],
	] as const)("routes a completed fix pass from %s back to the requesting stage", (status, target, mode) => {
		const decision = controller.transition(state(status), { mode: "code", result: "COMPLETED" })

		expect(decision).toEqual({ type: "start_mode", status: target, mode })
	})

	it("stops every stage when the model reports BLOCKED", () => {
		const decision = controller.transition(state("READY_FOR_REVIEW"), {
			mode: "reviewer",
			result: "BLOCKED",
		})

		expect(decision).toEqual({ type: "stop", status: "BLOCKED", reason: "blocked" })
	})

	it("rejects an outcome from a mode that does not own the current stage", () => {
		const decision = controller.transition(state("REVIEW"), { mode: "qa", result: "PASSED" })

		expect(decision).toEqual({
			type: "invalid",
			reason: "Mode qa cannot complete lifecycle status REVIEW",
		})
	})

	it("rejects a mode that only claims a stage marker it does not own", () => {
		const decision = controller.transition(state("DONE"), { mode: "code", result: "COMPLETED" })

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
					const decision = controller.transition(state(status), { mode, result })
					if (decision.type !== "start_mode" && decision.type !== "stop") {
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
					(result) => controller.transition(state(status), { mode, result }).type !== "invalid",
				)

				if (!routable) {
					unroutable.push(`${mode} cannot route any outcome from ${status}`)
				}
			}
		}

		expect(unroutable).toEqual([])
	})
})

describe("parseStageOutcome", () => {
	it("reads the semantic result while deriving the mode from runtime state", () => {
		expect(parseStageOutcome("reviewer", "Review complete.\nStage Result: PASSED")).toEqual({
			mode: "reviewer",
			result: "PASSED",
		})
	})

	it("ignores model-controlled routing fields", () => {
		expect(parseStageOutcome("reviewer", "Stage Result: PASSED\nNext Mode: code")).toEqual({
			mode: "reviewer",
			result: "PASSED",
		})
	})

	it("refuses an ambiguous report that declares the marker twice", () => {
		expect(parseStageOutcome("reviewer", "Stage Result: PASSED\nStage Result: FAILED")).toBeNull()
	})
})
