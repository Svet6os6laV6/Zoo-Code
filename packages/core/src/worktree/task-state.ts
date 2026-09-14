import { promises as fs } from "fs"
import * as path from "path"

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
	constructor(private readonly fileSystem: TaskStateFileSystem = fs) {}

	async resolve(context: TaskContext): Promise<TaskState> {
		let readme: string
		try {
			readme = await this.fileSystem.readFile(path.join(context.taskRoot, "README.md"), "utf8")
		} catch (error) {
			if (isFileNotFound(error)) {
				return {
					taskId: context.taskId,
					status: "ANALYSIS",
					currentTask: null,
					currentTaskArtifact: null,
				}
			}
			throw error
		}

		const protocolVersion = readField(readme, "Protocol Version")
		const isProtocolV2 = protocolVersion === "2"
		const artifactTaskId = readField(readme, "Task")
		if ((isProtocolV2 && !artifactTaskId) || (artifactTaskId && artifactTaskId !== context.taskId)) {
			throw new TaskStateError(
				`Task identity mismatch: expected ${context.taskId}, got ${artifactTaskId ?? "missing Task"}`,
			)
		}

		const rawStatus = readField(readme, "Status")
		const statusValue = !isProtocolV2 && rawStatus === "IN_PROGRESS" ? "IMPLEMENTATION" : rawStatus
		if (!statusValue || !isTaskStatus(statusValue)) {
			throw new TaskStateError(`Invalid task status: ${statusValue ?? "missing Status"}`)
		}

		const currentTaskValue = readField(readme, "Current Task")
		if (!currentTaskValue) {
			if (!isProtocolV2) {
				return {
					taskId: context.taskId,
					status: statusValue,
					currentTask: null,
					currentTaskArtifact: null,
				}
			}
			throw new TaskStateError("Missing Current Task")
		}

		if (currentTaskValue === "NONE") {
			if (isProtocolV2 && statusValue === "IMPLEMENTATION") {
				throw new TaskStateError("IMPLEMENTATION requires Current Task")
			}

			return {
				taskId: context.taskId,
				status: statusValue,
				currentTask: null,
				currentTaskArtifact: null,
			}
		}

		const currentTaskMatch = /^implementation\/(T\d{2,})(?:-[^/]+)?\.md$/.exec(currentTaskValue)
		if (!currentTaskMatch) {
			throw new TaskStateError(`Invalid Current Task: ${currentTaskValue}`)
		}
		if (statusValue !== "IMPLEMENTATION") {
			throw new TaskStateError(`${statusValue} requires Current Task: NONE`)
		}

		const currentTask = currentTaskMatch[1]
		if (!currentTask) {
			throw new TaskStateError(`Invalid Current Task: ${currentTaskValue}`)
		}

		return {
			taskId: context.taskId,
			status: statusValue,
			currentTask,
			currentTaskArtifact: path.join(context.taskRoot, ...currentTaskValue.split("/")),
		}
	}

	static transition(current: TaskStatus, next: TaskStatus): TaskStatus {
		if (!TRANSITIONS[current].some((status) => status === next)) {
			throw new TaskStateError(`Invalid task state transition: ${current} -> ${next}`)
		}

		return next
	}
}
