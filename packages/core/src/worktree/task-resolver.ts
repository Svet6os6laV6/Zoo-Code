import * as path from "path"

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
	) {}

	async resolve(context: TaskResolveContext): Promise<TaskContext> {
		const branch = await this.git.getCurrentBranch(context.workspacePath)
		if (!branch) {
			throw new TaskResolutionError(UNRESOLVED_TASK_MESSAGE)
		}

		const flags = this.taskIdPattern.flags.includes("g") ? this.taskIdPattern.flags : `${this.taskIdPattern.flags}g`
		const matches = new Set(
			Array.from(branch.matchAll(new RegExp(this.taskIdPattern.source, flags)), (match) => match[0]),
		)

		if (matches.size === 0) {
			throw new TaskResolutionError(UNRESOLVED_TASK_MESSAGE)
		}
		if (matches.size > 1) {
			throw new TaskResolutionError(`Multiple task IDs found in current Git branch: ${[...matches].join(", ")}`)
		}

		const taskId = matches.values().next().value
		if (!taskId) {
			throw new TaskResolutionError(UNRESOLVED_TASK_MESSAGE)
		}

		return {
			taskId,
			branch,
			taskRoot: path.join(path.resolve(context.workspacePath), ".roo", "tasks", taskId),
		}
	}
}
