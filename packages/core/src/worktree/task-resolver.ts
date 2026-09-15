import * as path from "path"

import { harnessLogger } from "../observability/harness-logger.js"
import type { HarnessLoggerPort } from "../observability/types.js"

import { worktreeService } from "./worktree-service.js"

const DEFAULT_TASK_ID_PATTERN = /[A-Z][A-Z0-9]+-\d+/g
const UNRESOLVED_TASK_MESSAGE = "Unable to resolve task ID from current Git branch"

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

export class TaskResolver {
	constructor(
		private readonly git: Pick<typeof worktreeService, "getCurrentBranch"> = worktreeService,
		private readonly taskIdPattern: RegExp = DEFAULT_TASK_ID_PATTERN,
		/** Explicit injection for tests; defaults to the process-wide harness logger. */
		private readonly logger?: HarnessLoggerPort,
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

		const flags = this.taskIdPattern.flags.includes("g") ? this.taskIdPattern.flags : `${this.taskIdPattern.flags}g`
		const matches = new Set(
			Array.from(branch.matchAll(new RegExp(this.taskIdPattern.source, flags)), (match) => match[0]),
		)

		if (matches.size === 0) {
			logger.decision("harness.task.resolve", {
				level: "warn",
				input: { ...input, branch },
				result: null,
				reason: "current Git branch does not contain a task ID",
				attributes: { reasonCode: "no-task-id", branch },
			})
			throw new TaskResolutionError(UNRESOLVED_TASK_MESSAGE)
		}
		if (matches.size > 1) {
			const candidates = [...matches]
			logger.decision("harness.task.resolve", {
				level: "warn",
				input: { ...input, branch },
				result: null,
				reason: "current Git branch contains more than one task ID",
				attributes: { reasonCode: "ambiguous-task-id", branch, candidates },
			})
			throw new TaskResolutionError(`Multiple task IDs found in current Git branch: ${candidates.join(", ")}`)
		}

		const taskId = matches.values().next().value
		if (!taskId) {
			logger.decision("harness.task.resolve", {
				level: "warn",
				input: { ...input, branch },
				result: null,
				reason: "task ID matched but could not be read from the match set",
				attributes: { reasonCode: "no-task-id", branch },
			})
			throw new TaskResolutionError(UNRESOLVED_TASK_MESSAGE)
		}

		const resolved: TaskContext = {
			taskId,
			branch,
			taskRoot: path.join(path.resolve(context.workspacePath), ".roo", "tasks", taskId),
		}

		logger.decision("harness.task.resolve", {
			input: { ...input, branch },
			result: resolved,
			reason: "task ID extracted from the current Git branch",
			attributes: { reasonCode: "resolved", branch, taskId },
			context: { taskId },
		})

		return resolved
	}
}
