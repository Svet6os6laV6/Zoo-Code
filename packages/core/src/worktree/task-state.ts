import { promises as fs } from "fs"
import * as path from "path"

import { isFileNotFound } from "../fs-errors.js"
import { harnessLogger } from "../observability/harness-logger.js"
import type { HarnessLogLevel, HarnessLoggerPort } from "../observability/types.js"

import type { TaskContext } from "./task-resolver.js"

export const TASK_STATUSES = [
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
	/** Semantic id of the failure currently being remediated, or `null` when no fix pass is running. */
	readonly failureKey: string | null
	/** Fix passes already spent on {@link failureKey}; `0` when no fix pass is running. */
	readonly failureAttempts: number
}

type TaskStateFileSystem = {
	readFile(filePath: string, encoding: "utf8"): Promise<string>
}

/**
 * The canonical README status machine — the single source of truth for which
 * status may follow which.
 *
 * Every status the harness *writes* must appear as an edge here: `ModeRunner`
 * only persists a decision after `LifecycleController` validated it against this
 * table. A lifecycle rule that needs a new edge must add it here, which keeps the
 * stage model and the canonical status model from drifting apart.
 *
 * Beyond the forward pipeline, three edges exist to close remediation loops:
 * `REVIEW`, `REFACTOR`, and `QA_READY` are the "a fix pass is running" markers a
 * failing stage writes, and each one returns to the entry status of the stage
 * that requested the fix (`READY_FOR_REVIEW`, `READY_FOR_REFACTOR`,
 * `REVIEW_PASSED`) so that stage re-verifies the fix.
 */
export const TASK_STATUS_TRANSITIONS = {
	ANALYSIS: ["READY_FOR_IMPLEMENTATION", "IMPLEMENTATION", "BLOCKED"],
	READY_FOR_IMPLEMENTATION: ["IMPLEMENTATION", "BLOCKED"],
	// `READY_FOR_IMPLEMENTATION` is the parking edge: an assigned unit that turned
	// out not to be ready (a dependency on another unit was discovered) returns to
	// the queue so the scheduler can recompute the DAG. It is not a remediation
	// marker — the unit itself goes back to `TODO`, not to a fix pass.
	IMPLEMENTATION: [
		"IMPLEMENTATION",
		"ANALYSIS",
		"READY_FOR_IMPLEMENTATION",
		"READY_FOR_REFACTOR",
		"READY_FOR_REVIEW",
		"BLOCKED",
	],
	READY_FOR_REFACTOR: ["REFACTOR", "READY_FOR_REVIEW", "BLOCKED"],
	REFACTOR: ["IMPLEMENTATION", "READY_FOR_REFACTOR", "READY_FOR_REVIEW", "BLOCKED"],
	READY_FOR_REVIEW: ["REVIEW", "REVIEW_PASSED", "BLOCKED"],
	REVIEW: ["IMPLEMENTATION", "READY_FOR_REVIEW", "REVIEW_PASSED", "BLOCKED"],
	REVIEW_PASSED: ["IMPLEMENTATION", "QA_READY", "DONE", "BLOCKED"],
	QA_READY: ["IMPLEMENTATION", "REVIEW_PASSED", "DONE", "BLOCKED"],
	DONE: [],
	// The resume edge: a task stopped at `BLOCKED` returns to the implementation
	// queue once the harness confirms the Unblock Condition. `BLOCKED` stays
	// otherwise terminal — no stage outcome leaves it, only the harness-owned
	// resume action does.
	BLOCKED: ["READY_FOR_IMPLEMENTATION"],
} as const satisfies Record<TaskStatus, readonly TaskStatus[]>

export class TaskStateError extends Error {
	override readonly name = "TaskStateError"
}

function isTaskStatus(value: string): value is TaskStatus {
	return TASK_STATUSES.some((status) => status === value)
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
					failureKey: null,
					failureAttempts: 0,
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

		// The failure-tracking block is read once, before any state is built, so every
		// exit path carries the same counter semantics instead of re-parsing the fields.
		// The canonical `NONE` sentinel means "no active failure", never a real key.
		const rawFailureKey = readField(readme, "Failure Key")
		const failureKey = rawFailureKey === undefined || rawFailureKey === "NONE" ? null : rawFailureKey
		const rawFailureAttempts = readField(readme, "Failure Attempts")
		if (rawFailureAttempts !== undefined && !/^\d+$/.test(rawFailureAttempts)) {
			const message = `Invalid Failure Attempts: ${rawFailureAttempts}`
			decide(null, message, "invalid-failure-attempts", { rawFailureAttempts }, "warn")
			throw new TaskStateError(message)
		}
		const failureAttempts = rawFailureAttempts === undefined ? 0 : Number.parseInt(rawFailureAttempts, 10)

		const currentTaskValue = readField(readme, "Current Task")
		if (!currentTaskValue) {
			if (!isProtocolV2) {
				const state: TaskState = {
					taskId: context.taskId,
					status: statusValue,
					currentTask: null,
					currentTaskArtifact: null,
					failureKey,
					failureAttempts,
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
				failureKey,
				failureAttempts,
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
			failureKey,
			failureAttempts,
		}
		decide(state, "README resolved to an implementation unit", "resolved", {
			normalizedStatus,
			currentTaskValue,
		})

		return state
	}

	static transition(current: TaskStatus, next: TaskStatus): TaskStatus {
		if (!isTaskStatusTransition(current, next)) {
			throw new TaskStateError(`Invalid task state transition: ${current} -> ${next}`)
		}

		return next
	}
}

/** Non-throwing counterpart of {@link TaskStateResolver.transition}. */
export function isTaskStatusTransition(current: TaskStatus, next: TaskStatus): boolean {
	return TASK_STATUS_TRANSITIONS[current].some((status) => status === next)
}
