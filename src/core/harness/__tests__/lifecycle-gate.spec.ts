// npx vitest run core/harness/__tests__/lifecycle-gate.spec.ts

import * as path from "path"

import type { TaskStatus } from "@roo-code/core"

import {
	HARNESS_GATE_STATUSES,
	STAGE_MODES,
	evaluateArtifactMutationGate,
	evaluateStageLaunchGate,
	evaluateStageModeSwitchGate,
	evaluateUnitMutationGate,
	isHarnessGateStatus,
	isPathInsideDirectory,
	isStageMode,
} from "../lifecycle-gate"

describe("lifecycle-gate", () => {
	it("rejects every stage mode on every harness-owned gate status", () => {
		for (const status of HARNESS_GATE_STATUSES) {
			for (const mode of STAGE_MODES) {
				const decision = evaluateStageLaunchGate(status, mode)

				expect(decision.allowed).toBe(false)
				if (!decision.allowed) {
					expect(decision.reason).toContain(status)
				}
			}
		}
	})

	it("allows stage modes in statuses where the stage is legitimate", () => {
		const allowedStatuses: TaskStatus[] = [
			"ANALYSIS",
			"READY_FOR_IMPLEMENTATION",
			"IMPLEMENTATION",
			"READY_FOR_REFACTOR",
			"REFACTOR",
			"READY_FOR_REVIEW",
			"REVIEW",
			"REVIEW_PASSED",
			"QA_READY",
			"DONE",
		]

		for (const status of allowedStatuses) {
			for (const mode of STAGE_MODES) {
				expect(evaluateStageLaunchGate(status, mode)).toEqual({ allowed: true })
			}
		}
	})

	it("allows non-stage modes on harness-owned gate statuses", () => {
		for (const status of HARNESS_GATE_STATUSES) {
			for (const mode of ["orchestrator", "ask", "debug", "custom-mode"]) {
				expect(evaluateStageLaunchGate(status, mode)).toEqual({ allowed: true })
			}
		}
	})

	it("classifies gate statuses and stage modes", () => {
		expect(isHarnessGateStatus("PLAN_READY")).toBe(true)
		expect(isHarnessGateStatus("BLOCKED")).toBe(true)
		expect(isHarnessGateStatus("IMPLEMENTATION")).toBe(false)

		expect(isStageMode("code")).toBe(true)
		expect(isStageMode("orchestrator")).toBe(false)
	})
})

describe("artifact-mutation gate", () => {
	const artifactsRoot = path.resolve("/workspace", ".roo", "tasks", "fix-01")

	it("rejects a target inside the artifacts root on every harness-owned gate status", () => {
		const target = path.join(artifactsRoot, "implementation", "T01-x.md")

		for (const status of HARNESS_GATE_STATUSES) {
			const decision = evaluateArtifactMutationGate(target, artifactsRoot, status)

			expect(decision.allowed).toBe(false)
			if (!decision.allowed) {
				expect(decision.reason).toContain(status)
			}
		}
	})

	it("allows a target inside the artifacts root in statuses where mutation is legitimate", () => {
		const target = path.join(artifactsRoot, "implementation", "T01-x.md")
		const allowedStatuses: TaskStatus[] = [
			"ANALYSIS",
			"READY_FOR_IMPLEMENTATION",
			"IMPLEMENTATION",
			"READY_FOR_REFACTOR",
			"REFACTOR",
			"READY_FOR_REVIEW",
			"REVIEW",
			"REVIEW_PASSED",
			"QA_READY",
			"DONE",
		]

		for (const status of allowedStatuses) {
			expect(evaluateArtifactMutationGate(target, artifactsRoot, status)).toEqual({ allowed: true })
		}
	})

	it("allows a target outside the artifacts root on harness-owned gate statuses", () => {
		const outside = path.resolve("/workspace", "src", "core", "task", "Task.ts")

		for (const status of HARNESS_GATE_STATUSES) {
			expect(evaluateArtifactMutationGate(outside, artifactsRoot, status)).toEqual({ allowed: true })
		}
	})

	it("does not treat a sibling directory with a shared prefix as inside", () => {
		const sibling = path.resolve("/workspace", ".roo", "tasks", "fix-01-other", "README.md")

		expect(evaluateArtifactMutationGate(sibling, artifactsRoot, "PLAN_READY")).toEqual({ allowed: true })
	})

	it("treats the artifacts root itself as inside", () => {
		expect(isPathInsideDirectory(artifactsRoot, artifactsRoot)).toBe(true)
		expect(isPathInsideDirectory(path.join(artifactsRoot, "README.md"), artifactsRoot)).toBe(true)
		expect(isPathInsideDirectory(path.resolve(artifactsRoot, "..", "other"), artifactsRoot)).toBe(false)
	})
})

describe("stage-mode-switch gate", () => {
	const base = {
		status: "IMPLEMENTATION" as TaskStatus,
		currentMode: "code",
		targetMode: "reviewer",
		hasParentTask: true,
	}

	it("rejects a delegated stage child switching to another stage mode", () => {
		const decision = evaluateStageModeSwitchGate(base)

		expect(decision.allowed).toBe(false)
		if (!decision.allowed) {
			expect(decision.gate).toBe("stage-mode-switch")
			expect(decision.reason).toContain("code")
			expect(decision.reason).toContain("reviewer")
		}
	})

	it("allows a root task to switch between stage modes", () => {
		expect(evaluateStageModeSwitchGate({ ...base, hasParentTask: false })).toEqual({ allowed: true })
	})

	it("allows a delegated child to switch to a non-stage mode", () => {
		expect(evaluateStageModeSwitchGate({ ...base, targetMode: "ask" })).toEqual({ allowed: true })
	})

	it("allows a delegated child whose current mode is not a stage mode", () => {
		expect(evaluateStageModeSwitchGate({ ...base, currentMode: "orchestrator" })).toEqual({ allowed: true })
	})

	it("allows a no-op switch to the same stage mode", () => {
		expect(evaluateStageModeSwitchGate({ ...base, targetMode: "code" })).toEqual({ allowed: true })
	})
})

describe("unit-mutation gate", () => {
	const artifactsRoot = path.resolve("/workspace", ".roo", "tasks", "fix-2")
	const assigned = path.join(artifactsRoot, "implementation", "T05-stage-gates-extension.md")
	const other = path.join(artifactsRoot, "implementation", "T07-orchestrator-plan-approval.md")
	const base = {
		artifactsRoot,
		status: "IMPLEMENTATION" as TaskStatus,
		assignedArtifact: assigned,
		hasParentTask: true,
		currentMode: "code",
	}

	it("rejects a delegated stage child mutating another unit", () => {
		const decision = evaluateUnitMutationGate({ ...base, targetPath: other })

		expect(decision.allowed).toBe(false)
		if (!decision.allowed) {
			expect(decision.gate).toBe("unit-mutation")
			expect(decision.reason).toContain(other)
		}
	})

	it("allows a delegated stage child mutating its assigned unit", () => {
		expect(evaluateUnitMutationGate({ ...base, targetPath: assigned })).toEqual({ allowed: true })
	})

	it("allows a root task mutating any unit", () => {
		expect(evaluateUnitMutationGate({ ...base, targetPath: other, hasParentTask: false })).toEqual({
			allowed: true,
		})
	})

	it("allows a delegated child in a non-stage mode", () => {
		expect(evaluateUnitMutationGate({ ...base, targetPath: other, currentMode: "orchestrator" })).toEqual({
			allowed: true,
		})
	})

	it("allows mutations outside implementation/", () => {
		expect(evaluateUnitMutationGate({ ...base, targetPath: path.join(artifactsRoot, "README.md") })).toEqual({
			allowed: true,
		})
		expect(
			evaluateUnitMutationGate({ ...base, targetPath: path.resolve("/workspace", "src", "core", "index.ts") }),
		).toEqual({ allowed: true })
	})

	it("allows mutations in statuses other than IMPLEMENTATION", () => {
		expect(evaluateUnitMutationGate({ ...base, targetPath: other, status: "REVIEW" })).toEqual({ allowed: true })
	})

	it("rejects when no unit is assigned", () => {
		const decision = evaluateUnitMutationGate({ ...base, targetPath: other, assignedArtifact: null })

		expect(decision.allowed).toBe(false)
	})
})
