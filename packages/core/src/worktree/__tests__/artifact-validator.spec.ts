import * as path from "path"

import { ArtifactValidator, formatArtifactValidationIssues } from "../artifact-validator.js"
import type { TaskContext } from "../task-resolver.js"
import { parseImplementationTask, type ImplementationArtifacts } from "../txx-parser.js"
import { createInMemoryFileSystem } from "./helpers/in-memory-fs.js"

const taskRoot = path.join("/workspace", ".roo", "tasks", "SITESUP-1116")
const implementation = path.join(taskRoot, "implementation")

const taskContext: TaskContext = {
	taskId: "SITESUP-1116",
	branch: "feature/SITESUP-1116-heartbeat",
	taskRoot,
}

/** A `null` override removes the file, which is how a missing artifact is expressed. */
function files(overrides: Record<string, string | null> = {}): Record<string, string> {
	const base: Record<string, string> = {
		[path.join(taskRoot, "README.md")]:
			"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\nCurrent Task: implementation/T01-trigger.md\n",
		[path.join(taskRoot, "implementation-plan.md")]: "# Plan\n",
		[path.join(taskRoot, "handoff.md")]: "# Handoff\n",
		[path.join(implementation, "T01-trigger.md")]: "## Status\nStatus: DONE\n",
		[path.join(implementation, "T02-worker.md")]:
			"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
	}

	for (const [filePath, content] of Object.entries(overrides)) {
		if (content === null) {
			delete base[filePath]
		} else {
			base[filePath] = content
		}
	}

	return base
}

function validatorFor(overrides: Record<string, string | null> = {}): ArtifactValidator {
	return new ArtifactValidator(createInMemoryFileSystem(files(overrides)))
}

describe("ArtifactValidator", () => {
	it("accepts a structurally valid task", async () => {
		const report = await validatorFor().validate(taskContext, { status: "IMPLEMENTATION" })

		expect(report.valid).toBe(true)
		expect(report.errors).toEqual([])
		expect(report.warnings).toEqual([])
	})

	it("reports a dependency that does not exist", async () => {
		const report = await validatorFor({
			[path.join(implementation, "T03-reconciler.md")]:
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01, T99\n",
		}).validate(taskContext, { status: "IMPLEMENTATION" })

		expect(report.valid).toBe(false)
		expect(report.errors).toContainEqual({
			severity: "error",
			code: "unknown-dependency",
			taskId: "T03",
			message: "dependency T99 does not exist",
		})
	})

	it("reports a dependency cycle", async () => {
		const report = await validatorFor({
			[path.join(implementation, "T01-trigger.md")]:
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T02\n",
		}).validate(taskContext, { status: "IMPLEMENTATION" })

		expect(report.errors).toContainEqual({
			severity: "error",
			code: "dependency-cycle",
			taskId: "T01",
			message: "dependency cycle: T01 -> T02 -> T01",
		})
	})

	it("reports duplicate task IDs", async () => {
		const report = await validatorFor({
			[path.join(implementation, "T01-duplicate.md")]: "## Status\nStatus: TODO\n",
		}).validate(taskContext, { status: "IMPLEMENTATION" })

		expect(report.errors).toContainEqual({
			severity: "error",
			code: "duplicate-task-id",
			taskId: "T01",
			message: "duplicate task ID across implementation artifacts",
		})
	})

	it("reports a missing and an invalid implementation unit status", async () => {
		const report = await validatorFor({
			[path.join(implementation, "T03-reconciler.md")]: "# T03\n\n## Goal\n\nReconcile.\n",
			[path.join(implementation, "T04-integration.md")]: "## Status\nStatus: STARTED\n",
		}).validate(taskContext, { status: "IMPLEMENTATION" })

		expect(report.errors).toContainEqual({
			severity: "error",
			code: "missing-task-status",
			taskId: "T03",
			message: "missing Status",
		})
		expect(report.errors).toContainEqual({
			severity: "error",
			code: "invalid-task-status",
			taskId: "T04",
			message: "invalid Status: STARTED",
		})
	})

	it("reports a missing README", async () => {
		const report = await validatorFor({ [path.join(taskRoot, "README.md")]: null }).validate(taskContext)

		expect(report.errors).toContainEqual({
			severity: "error",
			code: "missing-readme",
			taskId: null,
			message: "Missing README.md for task SITESUP-1116",
		})
	})

	it("treats missing plan and handoff as warnings during analysis", async () => {
		const report = await validatorFor({
			[path.join(taskRoot, "README.md")]: "Protocol Version: 2\nTask: SITESUP-1116\nStatus: ANALYSIS\n",
			[path.join(taskRoot, "implementation-plan.md")]: null,
			[path.join(taskRoot, "handoff.md")]: null,
		}).validate(taskContext, { status: "ANALYSIS" })

		expect(report.valid).toBe(true)
		expect(report.warnings.map((item) => item.code)).toEqual(["missing-implementation-plan", "missing-handoff"])
	})

	it("treats missing plan and handoff as errors during implementation", async () => {
		const report = await validatorFor({
			[path.join(taskRoot, "implementation-plan.md")]: null,
			[path.join(taskRoot, "handoff.md")]: null,
		}).validate(taskContext, { status: "IMPLEMENTATION" })

		expect(report.valid).toBe(false)
		expect(report.errors.map((item) => item.code)).toEqual(["missing-implementation-plan", "missing-handoff"])
	})

	it("warns when no implementation unit is ready", async () => {
		const report = await validatorFor({
			[path.join(implementation, "T01-trigger.md")]: "## Status\nStatus: IN_PROGRESS\n",
			[path.join(implementation, "T02-worker.md")]:
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
		}).validate(taskContext, { status: "IMPLEMENTATION" })

		expect(report.valid).toBe(true)
		expect(report.warnings).toContainEqual({
			severity: "warning",
			code: "no-ready-task",
			taskId: null,
			message: "No ready implementation task: every pending task has an unfinished dependency",
		})
	})

	it("reports an unclosed code fence", async () => {
		const report = await validatorFor({
			[path.join(taskRoot, "README.md")]:
				"Protocol Version: 2\nTask: SITESUP-1116\nStatus: IMPLEMENTATION\n\n```text\nunclosed\n",
		}).validate(taskContext, { status: "IMPLEMENTATION" })

		expect(report.errors).toContainEqual({
			severity: "error",
			code: "unclosed-code-fence",
			taskId: null,
			message: "unclosed markdown code fence in README.md",
		})
	})

	it("warns about a markdown file that is not a Txx artifact", async () => {
		const report = await validatorFor({
			[path.join(implementation, "notes.md")]: "# Notes\n",
		}).validate(taskContext, { status: "IMPLEMENTATION" })

		expect(report.warnings).toContainEqual({
			severity: "warning",
			code: "unexpected-artifact",
			taskId: null,
			message: "implementation/notes.md: not a Txx artifact",
		})
	})
})

describe("ArtifactValidator snapshot contract", () => {
	it("validates the provided snapshot instead of re-reading implementation/", async () => {
		const provided: ImplementationArtifacts = {
			directory: implementation,
			missingDirectory: false,
			tasks: [
				parseImplementationTask(
					"T09-provided.md",
					path.join(implementation, "T09-provided.md"),
					"## Status\nStatus: TODO\n",
				),
			],
			duplicateIds: [],
			unexpectedFiles: [],
		}

		// The in-memory filesystem holds T01/T02; the report must describe T09.
		const report = await validatorFor().validate(taskContext, { status: "IMPLEMENTATION" }, provided)

		expect(report.artifacts).toBe(provided)
		expect(report.artifacts.tasks.map((task) => task.id)).toEqual(["T09"])
	})
})

describe("formatArtifactValidationIssues", () => {
	it("prefixes task-scoped issues with the implementation unit", () => {
		expect(
			formatArtifactValidationIssues([
				{
					severity: "error",
					code: "unknown-dependency",
					taskId: "T03",
					message: "dependency T99 does not exist",
				},
				{ severity: "error", code: "missing-handoff", taskId: null, message: "Missing handoff.md" },
			]),
		).toBe("T03: dependency T99 does not exist\nMissing handoff.md")
	})
})
