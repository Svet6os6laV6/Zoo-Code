/**
 * ArtifactValidator
 *
 * Structural validation of task artifacts. The guiding principle is:
 * syntax, structure, and references are checked by the program; meaning stays
 * with the model.
 *
 * The validator never throws for malformed artifacts. It returns a report with
 * precise, per-task issues so the harness can inject them into the mode prompt
 * and the model can repair the artifacts.
 *
 * Semantic questions (is this dependency architecturally correct, does
 * `Consumes` really match the dependency `Produces`) are intentionally out of
 * scope.
 */

import { promises as fs } from "fs"
import * as path from "path"

import { harnessLogger } from "../observability/harness-logger.js"
import type { HarnessLoggerPort } from "../observability/types.js"

import type { TaskContext } from "./task-resolver.js"
import type { TaskStatus } from "./task-state.js"
import {
	findDependencyCycles,
	hasUnclosedCodeFence,
	isFileNotFound,
	readyTasks,
	sortTasks,
	TxxParser,
	type ImplementationArtifacts,
	type ImplementationFileSystem,
} from "./txx-parser.js"

/**
 * Lifecycle stages that require a complete implementation decomposition.
 * Outside these stages missing artifacts are expected (for example during
 * `ANALYSIS`) and are reported as warnings instead of errors.
 */
const STAGES_REQUIRING_IMPLEMENTATION_ARTIFACTS: ReadonlySet<string> = new Set<TaskStatus>([
	"READY_FOR_IMPLEMENTATION",
	"IMPLEMENTATION",
	"READY_FOR_REFACTOR",
	"REFACTOR",
	"READY_FOR_REVIEW",
	"REVIEW",
	"REVIEW_PASSED",
	"QA_READY",
])

export type ArtifactValidationSeverity = "error" | "warning"

export type ArtifactValidationCode =
	| "invalid-task-state"
	| "missing-readme"
	| "missing-implementation-plan"
	| "missing-handoff"
	| "missing-implementation-directory"
	| "duplicate-task-id"
	| "missing-task-status"
	| "invalid-task-status"
	| "unknown-dependency"
	| "dependency-cycle"
	| "unclosed-code-fence"
	| "unexpected-artifact"
	| "no-ready-task"

export type ArtifactValidationIssue = {
	readonly severity: ArtifactValidationSeverity
	readonly code: ArtifactValidationCode
	/** Implementation unit the issue belongs to, or null for task-level issues. */
	readonly taskId: string | null
	readonly message: string
}

export type ArtifactValidationReport = {
	readonly issues: readonly ArtifactValidationIssue[]
	readonly errors: readonly ArtifactValidationIssue[]
	readonly warnings: readonly ArtifactValidationIssue[]
	readonly artifacts: ImplementationArtifacts
	readonly valid: boolean
}

export type ArtifactValidationOptions = {
	/** Resolved lifecycle status, when available. Drives severity of missing artifacts. */
	readonly status?: TaskStatus | null
}

export type ArtifactFileSystem = ImplementationFileSystem

function issue(
	severity: ArtifactValidationSeverity,
	code: ArtifactValidationCode,
	taskId: string | null,
	message: string,
): ArtifactValidationIssue {
	return { severity, code, taskId, message }
}

/**
 * Render issues for prompt injection, grouped by implementation unit:
 *
 * ```text
 * T03: dependency T99 does not exist
 * T04: missing Status
 * Missing implementation-plan.md
 * ```
 */
export function formatArtifactValidationIssues(issues: readonly ArtifactValidationIssue[]): string {
	return issues.map((item) => (item.taskId ? `${item.taskId}: ${item.message}` : item.message)).join("\n")
}

export class ArtifactValidator {
	constructor(
		private readonly fileSystem: ArtifactFileSystem = fs,
		private readonly parser: TxxParser = new TxxParser(fileSystem),
		/** Explicit injection for tests; defaults to the process-wide harness logger. */
		private readonly logger?: HarnessLoggerPort,
	) {}

	/**
	 * Validate the task artifacts.
	 *
	 * `artifacts` lets a caller that already read the implementation snapshot pass
	 * it in. That is the point of the parameter: validation and scheduling must
	 * judge the *same* filesystem state, so re-reading here would let a concurrent
	 * write make the validation decision and the assignment decision describe two
	 * different DAGs.
	 */
	async validate(
		context: TaskContext,
		options: ArtifactValidationOptions = {},
		artifacts?: ImplementationArtifacts,
	): Promise<ArtifactValidationReport> {
		const issues: ArtifactValidationIssue[] = []
		const requiresImplementationArtifacts = STAGES_REQUIRING_IMPLEMENTATION_ARTIFACTS.has(options.status ?? "")
		const missingSeverity: ArtifactValidationSeverity = requiresImplementationArtifacts ? "error" : "warning"

		const readme = await this.readOptional(path.join(context.taskRoot, "README.md"))
		if (readme === null) {
			issues.push(issue("error", "missing-readme", null, `Missing README.md for task ${context.taskId}`))
		} else if (hasUnclosedCodeFence(readme)) {
			issues.push(issue("error", "unclosed-code-fence", null, "unclosed markdown code fence in README.md"))
		}

		const plan = await this.readOptional(path.join(context.taskRoot, "implementation-plan.md"))
		if (plan === null) {
			issues.push(issue(missingSeverity, "missing-implementation-plan", null, "Missing implementation-plan.md"))
		} else if (hasUnclosedCodeFence(plan)) {
			issues.push(
				issue("error", "unclosed-code-fence", null, "unclosed markdown code fence in implementation-plan.md"),
			)
		}

		const handoff = await this.readOptional(path.join(context.taskRoot, "handoff.md"))
		if (handoff === null) {
			issues.push(issue(missingSeverity, "missing-handoff", null, "Missing handoff.md"))
		} else if (hasUnclosedCodeFence(handoff)) {
			issues.push(issue("error", "unclosed-code-fence", null, "unclosed markdown code fence in handoff.md"))
		}

		const snapshot = artifacts ?? (await this.parser.read(context))

		if (snapshot.missingDirectory) {
			issues.push(
				issue(missingSeverity, "missing-implementation-directory", null, "Missing implementation/ directory"),
			)
		}

		for (const id of snapshot.duplicateIds) {
			issues.push(issue("error", "duplicate-task-id", id, "duplicate task ID across implementation artifacts"))
		}

		const knownIds = new Set(snapshot.tasks.map((task) => task.id))

		for (const task of sortTasks(snapshot.tasks)) {
			if (task.statusProblem) {
				const code: ArtifactValidationCode = task.statusProblem.startsWith("missing")
					? "missing-task-status"
					: "invalid-task-status"
				issues.push(issue("error", code, task.id, task.statusProblem))
			}

			for (const dependency of task.dependsOn) {
				if (!knownIds.has(dependency)) {
					issues.push(
						issue("error", "unknown-dependency", task.id, `dependency ${dependency} does not exist`),
					)
				}
			}

			if (task.unclosedCodeFence) {
				issues.push(
					issue("error", "unclosed-code-fence", task.id, `unclosed markdown code fence in ${task.fileName}`),
				)
			}
		}

		for (const cycle of findDependencyCycles(snapshot.tasks)) {
			issues.push(issue("error", "dependency-cycle", cycle[0] ?? null, `dependency cycle: ${cycle.join(" -> ")}`))
		}

		const pending = snapshot.tasks.filter((task) => task.status === "TODO" || task.status === "IN_PROGRESS")
		if (pending.length > 0 && readyTasks(snapshot.tasks).length === 0) {
			issues.push(
				issue(
					"warning",
					"no-ready-task",
					null,
					"No ready implementation task: every pending task has an unfinished dependency",
				),
			)
		}

		for (const fileName of snapshot.unexpectedFiles) {
			issues.push(issue("warning", "unexpected-artifact", null, `implementation/${fileName}: not a Txx artifact`))
		}

		const errors = issues.filter((item) => item.severity === "error")
		const warnings = issues.filter((item) => item.severity === "warning")
		const valid = errors.length === 0

		harnessLogger(this.logger).decision("harness.artifacts.validate", {
			level: valid ? "info" : "warn",
			input: {
				taskId: context.taskId,
				status: options.status ?? null,
				requiresImplementationArtifacts,
				taskCount: snapshot.tasks.length,
				missingDirectory: snapshot.missingDirectory,
			},
			result: { valid, errorCount: errors.length, warningCount: warnings.length },
			reason: valid
				? "no structural artifact issues found"
				: `${errors.length} structural artifact error(s) require repair`,
			attributes: {
				reasonCode: valid ? "valid" : "invalid",
				issues: issues.map((item) => ({
					severity: item.severity,
					code: item.code,
					taskId: item.taskId,
					message: item.message,
				})),
				duplicateIds: snapshot.duplicateIds,
				unexpectedFiles: snapshot.unexpectedFiles,
			},
			context: { taskId: context.taskId },
		})

		return { issues, errors, warnings, artifacts: snapshot, valid }
	}

	private async readOptional(filePath: string): Promise<string | null> {
		try {
			return await this.fileSystem.readFile(filePath, "utf8")
		} catch (error) {
			if (isFileNotFound(error)) {
				return null
			}
			throw error
		}
	}
}
