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
		const branch = await this.git.getCurrentBranch(context.workspacePath)

		if (!branch) {
			this.reject(logger, null, {
				reasonCode: "no-branch",
				reason: "current Git branch could not be determined",
				message: UNRESOLVED_TASK_MESSAGE,
			})
		}

		const { taskId, reason, reasonCode } = this.resolveTaskId(logger, branch)
		const taskRoot = path.join(path.resolve(context.workspacePath), ".roo", "tasks", taskId)

		await this.ensureTaskRoot(logger, taskRoot, taskId, branch)

		const resolved: TaskContext = { taskId, branch, taskRoot }

		logger.decision("harness.task.resolve", {
			input: { branch },
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
	private resolveTaskId(
		logger: HarnessLoggerPort,
		branch: string,
	): { taskId: string; reason: string; reasonCode: string } {
		const flags = this.taskIdPattern.flags.includes("g") ? this.taskIdPattern.flags : `${this.taskIdPattern.flags}g`
		const matches = new Set(
			Array.from(branch.matchAll(new RegExp(this.taskIdPattern.source, flags)), (match) => match[0]),
		)

		if (matches.size > 1) {
			const candidates = [...matches]
			this.reject(logger, branch, {
				reasonCode: "ambiguous-task-id",
				reason: "current Git branch contains more than one task ID",
				message: `Multiple task IDs found in current Git branch: ${candidates.join(", ")}`,
				attributes: { candidates },
			})
		}

		const matchedTaskId = matches.values().next().value
		if (matches.size === 1 && !matchedTaskId) {
			// Defensive: a pattern that also matches the empty string yields no usable ID.
			this.reject(logger, branch, {
				reasonCode: "no-task-id",
				reason: "task ID matched but could not be read from the match set",
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
			this.reject(logger, branch, {
				reasonCode: "fallback-branch-name-empty",
				reason: "current Git branch does not contain a task ID and its sanitized name is empty",
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
	 * never hit ENOENT.
	 */
	private async ensureTaskRoot(
		logger: HarnessLoggerPort,
		taskRoot: string,
		taskId: string,
		branch: string,
	): Promise<void> {
		try {
			await this.fileSystem.mkdir(taskRoot, { recursive: true })
		} catch (error) {
			this.reject(logger, branch, {
				reasonCode: "task-root-create-failed",
				reason: "task root directory could not be created",
				message: `Unable to create task root directory ${taskRoot}: ${errorMessage(error)}`,
				attributes: { taskId },
			})
		}
	}

	/** Records a rejected decision and throws, so every rejection has the same shape. */
	private reject(
		logger: HarnessLoggerPort,
		branch: string | null,
		rejection: {
			readonly reasonCode: string
			readonly reason: string
			readonly message: string
			readonly attributes?: Readonly<Record<string, unknown>>
		},
	): never {
		logger.decision("harness.task.resolve", {
			level: "warn",
			input: branch === null ? null : { branch },
			result: null,
			reason: rejection.reason,
			attributes: {
				reasonCode: rejection.reasonCode,
				...(branch === null ? {} : { branch }),
				...rejection.attributes,
			},
		})
		throw new TaskResolutionError(rejection.message)
	}
}
