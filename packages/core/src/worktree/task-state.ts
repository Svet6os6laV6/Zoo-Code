import { promises as fs } from "fs"
import * as path from "path"

import { harnessLogger } from "../observability/harness-logger.js"
import type { HarnessLogLevel, HarnessLoggerPort } from "../observability/types.js"

import type { TaskContext } from "./task-resolver.js"

const TASK_STATUSES = [
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
	"BLOCKED",
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export type TaskState = {
	readonly taskId: string
	readonly status: TaskStatus
	readonly currentTask: string | null
	readonly currentTaskArtifact: string | null
}

type TaskStateFileSystem = {
	readFile(filePath: string, encoding: "utf8"): Promise<string>
}

const TRANSITIONS = {
	ANALYSIS: ["READY_FOR_IMPLEMENTATION", "IMPLEMENTATION", "BLOCKED"],
	READY_FOR_IMPLEMENTATION: ["IMPLEMENTATION", "BLOCKED"],
	IMPLEMENTATION: ["IMPLEMENTATION", "ANALYSIS", "READY_FOR_REFACTOR", "READY_FOR_REVIEW", "BLOCKED"],
	READY_FOR_REFACTOR: ["REFACTOR", "BLOCKED"],
	REFACTOR: ["IMPLEMENTATION", "READY_FOR_REVIEW", "BLOCKED"],
	READY_FOR_REVIEW: ["REVIEW", "BLOCKED"],
	REVIEW: ["IMPLEMENTATION", "REVIEW_PASSED", "BLOCKED"],
	REVIEW_PASSED: ["IMPLEMENTATION", "QA_READY", "BLOCKED"],
	QA_READY: ["IMPLEMENTATION", "DONE", "BLOCKED"],
	DONE: [],
	BLOCKED: [],
} as const satisfies Record<TaskStatus, readonly TaskStatus[]>

export class TaskStateError extends Error {
	override readonly name = "TaskStateError"
}

function isTaskStatus(value: string): value is TaskStatus {
	return TASK_STATUSES.some((status) => status === value)
}

function isFileNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function readField(content: string, name: string): string | undefined {
	const prefix = `${name}:`
	const values = content
		.split(/\r?\n/)
		.filter((line) => line.startsWith(prefix))
		.map((line) => line.slice(prefix.length).trim())

	if (values.length > 1) {
		throw new TaskStateError(`Duplicate ${name} field`)
	}

	return values[0]
}

export class TaskStateResolver {
	constructor(
		private readonly fileSystem: TaskStateFileSystem = fs,
		/** Explicit injection for tests; defaults to the process-wide harness logger. */
		private readonly logger?: HarnessLoggerPort,
	) {}

	async resolve(context: TaskContext): Promise<TaskState> {
		const logger = harnessLogger(this.logger)
		const input = { taskRoot: context.taskRoot, expectedTaskId: context.taskId }

		/**
		 * Every exit path records the README-derived input, the resulting state
		 * (or `null` when the README is rejected), and why that outcome won.
		 */
		const decide = (
			result: TaskState | null,
			reason: string,
			reasonCode: string,
			attributes: Record<string, unknown> = {},
			level: HarnessLogLevel = "info",
		): void => {
			logger.decision("harness.taskState.resolve", {
				level,
				input,
				result,
				reason,
				attributes: { reasonCode, ...attributes },
				context: { taskId: context.taskId },
			})
		}

		let readme: string
		try {
			readme = await this.fileSystem.readFile(path.join(context.taskRoot, "README.md"), "utf8")
		} catch (error) {
			if (isFileNotFound(error)) {
				const state: TaskState = {
					taskId: context.taskId,
					status: "ANALYSIS",
					currentTask: null,
					currentTaskArtifact: null,
				}
				decide(state, "task README does not exist yet; a new task starts in ANALYSIS", "missing-readme")
				return state
			}
			throw error
		}

		const protocolVersion = readField(readme, "Protocol Version")
		const isProtocolV2 = protocolVersion === "2"
		const artifactTaskId = readField(readme, "Task")
		if ((isProtocolV2 && !artifactTaskId) || (artifactTaskId && artifactTaskId !== context.taskId)) {
			const message = `Task identity mismatch: expected ${context.taskId}, got ${artifactTaskId ?? "missing Task"}`
			decide(null, message, "identity-mismatch", { artifactTaskId: artifactTaskId ?? null, isProtocolV2 }, "warn")
			throw new TaskStateError(message)
		}

		const rawStatus = readField(readme, "Status")
		const statusValue = !isProtocolV2 && rawStatus === "IN_PROGRESS" ? "IMPLEMENTATION" : rawStatus
		if (!statusValue || !isTaskStatus(statusValue)) {
			const message = `Invalid task status: ${statusValue ?? "missing Status"}`
			decide(null, message, "invalid-status", { rawStatus: rawStatus ?? null, isProtocolV2 }, "warn")
			throw new TaskStateError(message)
		}

		const normalizedStatus = rawStatus !== statusValue

		const currentTaskValue = readField(readme, "Current Task")
		if (!currentTaskValue) {
			if (!isProtocolV2) {
				const state: TaskState = {
					taskId: context.taskId,
					status: statusValue,
					currentTask: null,
					currentTaskArtifact: null,
				}
				decide(
					state,
					"legacy README without a Current Task field; no implementation unit is assigned",
					"legacy-missing-current-task",
					{ normalizedStatus },
				)
				return state
			}
			decide(null, "protocol v2 README is missing the Current Task field", "missing-current-task", {}, "warn")
			throw new TaskStateError("Missing Current Task")
		}

		if (currentTaskValue === "NONE") {
			if (isProtocolV2 && statusValue === "IMPLEMENTATION") {
				const message = "IMPLEMENTATION requires Current Task"
				decide(null, message, "implementation-without-unit", { status: statusValue }, "warn")
				throw new TaskStateError(message)
			}

			const state: TaskState = {
				taskId: context.taskId,
				status: statusValue,
				currentTask: null,
				currentTaskArtifact: null,
			}
			decide(state, "README declares no current implementation unit", "no-current-task", { normalizedStatus })
			return state
		}

		const currentTaskMatch = /^implementation\/(T\d{2,})(?:-[^/]+)?\.md$/.exec(currentTaskValue)
		if (!currentTaskMatch) {
			const message = `Invalid Current Task: ${currentTaskValue}`
			decide(null, message, "invalid-current-task", { currentTaskValue }, "warn")
			throw new TaskStateError(message)
		}
		if (statusValue !== "IMPLEMENTATION") {
			const message = `${statusValue} requires Current Task: NONE`
			decide(null, message, "unit-outside-implementation", { status: statusValue, currentTaskValue }, "warn")
			throw new TaskStateError(message)
		}

		const currentTask = currentTaskMatch[1]
		if (!currentTask) {
			const message = `Invalid Current Task: ${currentTaskValue}`
			decide(null, message, "invalid-current-task", { currentTaskValue }, "warn")
			throw new TaskStateError(message)
		}

		const state: TaskState = {
			taskId: context.taskId,
			status: statusValue,
			currentTask,
			currentTaskArtifact: path.join(context.taskRoot, ...currentTaskValue.split("/")),
		}
		decide(state, "README resolved to an implementation unit", "resolved", {
			normalizedStatus,
			currentTaskValue,
		})

		return state
	}

	static transition(current: TaskStatus, next: TaskStatus): TaskStatus {
		if (!TRANSITIONS[current].some((status) => status === next)) {
			throw new TaskStateError(`Invalid task state transition: ${current} -> ${next}`)
		}

		return next
	}
}
