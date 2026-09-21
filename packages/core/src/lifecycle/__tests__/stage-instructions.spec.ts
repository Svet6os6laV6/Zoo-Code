import { LIFECYCLE_MODES, STAGE_FAILURE_KEY_MARKER, STAGE_RESULT_MARKER } from "../index.js"
import { STAGE_ARTIFACTS, STAGE_DIRECTIVES, buildStageInstruction } from "../stage-instructions.js"

describe("buildStageInstruction", () => {
	it("covers every lifecycle mode with artifacts and a directive", () => {
		for (const mode of LIFECYCLE_MODES) {
			expect(STAGE_ARTIFACTS[mode].length).toBeGreaterThan(0)
			expect(STAGE_DIRECTIVES[mode].length).toBeGreaterThan(0)
		}
	})

	it("names the task and the outcome marker for a plain stage start", () => {
		const instruction = buildStageInstruction({
			mode: "reviewer",
			taskId: "SITESUP-1116",
			assignedArtifact: null,
		})

		expect(instruction).toContain("Run the reviewer stage for SITESUP-1116.")
		expect(instruction).toContain(STAGE_RESULT_MARKER)
		expect(instruction).not.toContain(STAGE_FAILURE_KEY_MARKER)
	})

	it("adds the assigned implementation unit as a task-relative pointer", () => {
		const instruction = buildStageInstruction({
			mode: "code",
			taskId: "SITESUP-1116",
			assignedArtifact: "implementation/T02-worker.md",
		})

		expect(instruction).toContain("implementation/T02-worker.md")
	})

	it("asks a fix pass to repeat the failure key so the counter keeps its bucket", () => {
		const instruction = buildStageInstruction({
			mode: "code",
			taskId: "SITESUP-1116",
			assignedArtifact: null,
			failure: { key: "auth-token-expiry", attempts: 2 },
		})

		expect(instruction).toContain("fix pass 2")
		expect(instruction).toContain(`${STAGE_FAILURE_KEY_MARKER} auth-token-expiry`)
	})

	it("asks the qa stage for three commit message variants in qa.md", () => {
		expect(STAGE_ARTIFACTS.qa).toContain("qa.md")
		expect(STAGE_DIRECTIVES.qa).toContain("qa.md")
		expect(STAGE_DIRECTIVES.qa).toContain("three")
		expect(STAGE_DIRECTIVES.qa).toContain("commit message")
	})

	it("describes an unnamed fix pass without inventing a key", () => {
		const instruction = buildStageInstruction({
			mode: "code",
			taskId: "SITESUP-1116",
			assignedArtifact: null,
			failure: { key: null, attempts: 1 },
		})

		expect(instruction).toContain("an unnamed finding")
	})
})
