// npx vitest run core/harness/__tests__/lifecycle-gate.spec.ts

import * as path from "path"

import type { TaskStatus } from "@roo-code/core"

import {
	HARNESS_GATE_STATUSES,
	STAGE_MODES,
	evaluateArtifactMutationGate,
	evaluateStageLaunchGate,
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
