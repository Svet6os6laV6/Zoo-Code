import { promises as fs } from "fs"
import * as path from "path"

import { harnessLogger } from "../observability/harness-logger.js"
import type { HarnessLoggerPort } from "../observability/types.js"

import { worktreeService } from "./worktree-service.js"

const DEFAULT_TASK_ID_PATTERN = /[A-Z][A-Z0-9]+-\d+/g
const UNRESOLVED_TASK_MESSAGE = "Unable to resolve task ID from current Git branch"
const EMPTY_FALLBACK_MESSAGE = `${UNRESOLVED_TASK_MESSAGE}: sanitized branch name is empty`

export type TaskResolveContext = {
	readonly workspacePath: string
}

export type TaskContext = {
	readonly taskId: string
	readonly branch: string
	readonly taskRoot: string
}

export class TaskResolutionError extends Error {
	override readonly name = "TaskResolutionError"
}

/**
 * The only file system capability the resolver needs. Mirrors
 * `fs.promises.mkdir(dirPath, { recursive: true })`, which resolves to the first
 * directory it created and to `undefined` when the whole chain already existed.
 */
type TaskResolverFileSystem = {
	mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>
}

/** Input recorded on every `harness.task.resolve` record of one resolve call. */
type ResolveInput = {
	readonly workspacePath: string
	readonly taskIdPattern: string
}

/**
 * Per-call context shared by the resolution steps: the branch being resolved,
 * the decision input, and the logger.
 */
type ResolveScope = {
	/** Current Git branch, already known to be non-null. */
	readonly branch: string
	readonly input: ResolveInput
	readonly logger: HarnessLoggerPort
}

/** A rejected decision: the record to emit together with the error to throw. */
type Rejection = {
	readonly reason: string
	readonly reasonCode: string
	readonly message: string
	readonly attributes?: Readonly<Record<string, unknown>>
}

/**
 * Fallback task ID for branches without a pattern match: the full branch name
 * with every character outside `[A-Za-z0-9._-]` replaced by `-`, run-together
 * dots collapsed to a single `.`, and leading/trailing `-`/`.` trimmed.
 *
 * The result is used both as a directory name and inside the `agent/<taskId>`
 * worktree branch, so it must never contain `/`, `\`, or `..`.
 */
function sanitizeBranchTaskId(branch: string): string {
	return branch
		.replace(/[^A-Za-z0-9._-]/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/^[-.]+|[-.]+$/g, "")
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

export class TaskResolver {
	constructor(
		private readonly git: Pick<typeof worktreeService, "getCurrentBranch"> = worktreeService,
		private readonly taskIdPattern: RegExp = DEFAULT_TASK_ID_PATTERN,
		/** Explicit injection for tests; defaults to the process-wide harness logger. */
		private readonly logger?: HarnessLoggerPort,
		/** Explicit injection for tests; defaults to the real file system. */
		private readonly fileSystem: TaskResolverFileSystem = fs,
	) {}

	async resolve(context: TaskResolveContext): Promise<TaskContext> {
		const logger = harnessLogger(this.logger)
		const input = { workspacePath: context.workspacePath, taskIdPattern: this.taskIdPattern.source }

		const branch = await this.git.getCurrentBranch(context.workspacePath)
		if (!branch) {
			logger.decision("harness.task.resolve", {
				level: "warn",
				input,
				result: null,
				reason: "current Git branch could not be determined",
				attributes: { reasonCode: "no-branch" },
			})
			throw new TaskResolutionError(UNRESOLVED_TASK_MESSAGE)
		}

		const scope: ResolveScope = { branch, input, logger }
		const { taskId, reason, reasonCode } = this.resolveTaskId(scope)
		const taskRoot = path.join(path.resolve(context.workspacePath), ".roo", "tasks", taskId)

		await this.ensureTaskRoot(taskRoot, taskId, scope)

		const resolved: TaskContext = {
			taskId,
			branch,
			taskRoot,
		}

		logger.decision("harness.task.resolve", {
			input: { ...input, branch },
			result: resolved,
			reason,
			attributes: { reasonCode, branch, taskId },
			context: { taskId },
		})

		return resolved
	}

	/**
	 * Derives the task ID for the current branch: a match of the configured
	 * `taskIdPattern` wins, and a branch without any match falls back to its
	 * sanitized name.
	 */
	private resolveTaskId(scope: ResolveScope): { taskId: string; reason: string; reasonCode: string } {
		const { branch } = scope
		const flags = this.taskIdPattern.flags.includes("g") ? this.taskIdPattern.flags : `${this.taskIdPattern.flags}g`
		const matches = new Set(
			Array.from(branch.matchAll(new RegExp(this.taskIdPattern.source, flags)), (match) => match[0]),
		)

		if (matches.size > 1) {
			const candidates = [...matches]
			this.reject(scope, {
				reason: "current Git branch contains more than one task ID",
				reasonCode: "ambiguous-task-id",
				message: `Multiple task IDs found in current Git branch: ${candidates.join(", ")}`,
				attributes: { candidates },
			})
		}

		const matchedTaskId = matches.values().next().value
		if (matches.size === 1 && !matchedTaskId) {
			// Defensive: a pattern that also matches the empty string yields no usable ID.
			this.reject(scope, {
				reason: "task ID matched but could not be read from the match set",
				reasonCode: "no-task-id",
				message: UNRESOLVED_TASK_MESSAGE,
			})
		}

		if (matchedTaskId) {
			return {
				taskId: matchedTaskId,
				reason: "task ID extracted from the current Git branch",
				reasonCode: "resolved",
			}
		}

		const fallbackTaskId = sanitizeBranchTaskId(branch)
		if (!fallbackTaskId) {
			this.reject(scope, {
				reason: "current Git branch does not contain a task ID and its sanitized name is empty",
				reasonCode: "fallback-branch-name-empty",
				message: EMPTY_FALLBACK_MESSAGE,
			})
		}

		return {
			taskId: fallbackTaskId,
			reason: "task ID derived from the sanitized current Git branch name",
			reasonCode: "fallback-branch-name",
		}
	}

	/**
	 * Guarantees `.roo/tasks/<taskId>` exists so downstream readers and writers
	 * never hit ENOENT, and records the mutation.
	 */
	private async ensureTaskRoot(taskRoot: string, taskId: string, scope: ResolveScope): Promise<void> {
		let createdPath: string | undefined
		try {
			createdPath = await this.fileSystem.mkdir(taskRoot, { recursive: true })
		} catch (error) {
			this.reject(scope, {
				reason: "task root directory could not be created",
				reasonCode: "task-root-create-failed",
				message: `Unable to create task root directory ${taskRoot}: ${errorMessage(error)}`,
				attributes: { taskId },
			})
		}

		scope.logger.mutation("harness.task.resolve", {
			target: taskRoot,
			stateBefore: { existed: createdPath === undefined },
			stateAfter: { exists: true },
			reason: "task root directory ensured after resolving the task ID",
			attributes: { reasonCode: "task-root-ensured", taskId },
		})
	}

	/** Records a rejected decision and throws, so every rejection has the same shape. */
	private reject(scope: ResolveScope, rejection: Rejection): never {
		scope.logger.decision("harness.task.resolve", {
			level: "warn",
			input: { ...scope.input, branch: scope.branch },
			result: null,
			reason: rejection.reason,
			attributes: { reasonCode: rejection.reasonCode, branch: scope.branch, ...rejection.attributes },
		})
		throw new TaskResolutionError(rejection.message)
	}
}
