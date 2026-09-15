/**
 * TaskScheduler
 *
 * Programmatic DAG scheduler over the implementation artifacts.
 *
 * The Architect still decides the *meaning* of the dependencies (which task
 * depends on which). The scheduler only computes what is mechanically derivable:
 * which task is ready now, and which one to execute next.
 *
 * The harness owns the `Current Task` / `Status` mutation. When a Code session
 * starts, the scheduler assigns the next ready implementation unit and writes it
 * into the README canonical block, so the model receives an already assigned
 * task instead of selecting one itself.
 *
 * The current lifecycle is sequential: `readyTasks()` may return several tasks,
 * but `assignNext()` picks exactly one (lowest task number first). Parallel
 * execution can later consume the same ready set without changing artifacts.
 */

import { promises as fs } from "fs"
import * as path from "path"

import { harnessLogger } from "../observability/harness-logger.js"
import type { HarnessLoggerPort } from "../observability/types.js"

import type { TaskContext } from "./task-resolver.js"
import type { TaskState } from "./task-state.js"
import {
	readyTasks,
	sortTasks,
	TxxParser,
	type ImplementationArtifacts,
	type ImplementationFileSystem,
	type ImplementationTask,
} from "./txx-parser.js"

export type TaskSchedulerFileSystem = ImplementationFileSystem & {
	writeFile(filePath: string, data: string, encoding: "utf8"): Promise<void>
	rename(oldPath: string, newPath: string): Promise<void>
}

export type SchedulerPlan = {
	readonly artifacts: ImplementationArtifacts
	readonly ready: readonly ImplementationTask[]
	readonly inProgress: readonly ImplementationTask[]
	readonly done: readonly ImplementationTask[]
	readonly blocked: readonly ImplementationTask[]
}

export type TaskAssignment = {
	readonly task: ImplementationTask
	/** Path relative to the task root, e.g. `implementation/T02-worker-manual-run.md`. */
	readonly relativeArtifact: string
	/** Lifecycle state after the assignment was written to the README. */
	readonly state: TaskState
	/** Implementation unit that was replaced, when the previous one had finished. */
	readonly replaced: string | null
}

/** Canonical README fields the scheduler owns, used for mutation records. */
type CanonicalReadmeFields = {
	readonly status: string | null
	readonly currentTask: string | null
	readonly nextStep: string | null
}

function readCanonicalFields(readme: string): CanonicalReadmeFields {
	const read = (name: string): string | null => {
		const prefix = `${name.toLowerCase()}:`
		const line = readme.split(/\r?\n/).find((candidate) => candidate.trim().toLowerCase().startsWith(prefix))
		if (!line) {
			return null
		}
		return line.slice(line.indexOf(":") + 1).trim()
	}

	return { status: read("Status"), currentTask: read("Current Task"), nextStep: read("Next Step") }
}

export class TaskScheduler {
	constructor(
		private readonly fileSystem: TaskSchedulerFileSystem = fs,
		private readonly parser: TxxParser = new TxxParser(fileSystem),
		/** Explicit injection for tests; defaults to the process-wide harness logger. */
		private readonly logger?: HarnessLoggerPort,
	) {}

	/**
	 * Read-only view of the DAG. Safe to call on every task start.
	 */
	async plan(context: TaskContext): Promise<SchedulerPlan> {
		const logger = harnessLogger(this.logger)

		return logger.span(
			"harness.scheduler.plan",
			async (span) => {
				const artifacts = await this.parser.read(context)
				const plan: SchedulerPlan = {
					artifacts,
					ready: readyTasks(artifacts.tasks),
					inProgress: sortTasks(artifacts.tasks.filter((task) => task.status === "IN_PROGRESS")),
					done: sortTasks(artifacts.tasks.filter((task) => task.status === "DONE")),
					blocked: sortTasks(artifacts.tasks.filter((task) => task.status === "BLOCKED")),
				}

				span.annotate({
					ready: plan.ready.map((task) => task.id),
					inProgress: plan.inProgress.map((task) => task.id),
					done: plan.done.map((task) => task.id),
					blocked: plan.blocked.map((task) => task.id),
				})

				return plan
			},
			{ context: { taskId: context.taskId } },
		)
	}

	/**
	 * Assign the next ready implementation unit and persist it in the README.
	 *
	 * Returns `null` when no assignment is needed or possible:
	 * - the lifecycle stage does not execute implementation units;
	 * - the current unit is still `TODO`/`IN_PROGRESS` (resume, never reassign);
	 * - the current unit is referenced but its artifact is missing (a validation
	 *   error the model must repair, not something to silently skip);
	 * - no task is ready (a DAG conflict the model must resolve).
	 */
	async assignNext(context: TaskContext, state: TaskState): Promise<TaskAssignment | null> {
		const logger = harnessLogger(this.logger)
		const input = {
			status: state.status,
			currentTask: state.currentTask,
			currentTaskArtifact: state.currentTaskArtifact,
		}

		/**
		 * Every exit path records the DAG/lifecycle input, the outcome (`null`
		 * included), and why that outcome won.
		 */
		const skip = (reason: string, reasonCode: string, attributes: Record<string, unknown> = {}): null => {
			logger.decision("harness.scheduler.assignNext", {
				input,
				result: null,
				reason,
				attributes: { reasonCode, ...attributes },
				context: { taskId: state.taskId, txxId: state.currentTask },
			})
			return null
		}

		if (state.status !== "IMPLEMENTATION" && state.status !== "READY_FOR_IMPLEMENTATION") {
			return skip(
				`lifecycle stage ${state.status} does not execute implementation units`,
				"stage-not-implementation",
			)
		}

		const artifacts = await this.parser.read(context)
		const current = state.currentTask
			? (artifacts.tasks.find((task) => task.id === state.currentTask) ?? null)
			: null

		if (state.currentTask && !current) {
			return skip(
				`assigned implementation unit ${state.currentTask} is missing from implementation/`,
				"current-unit-missing",
				{ availableUnits: artifacts.tasks.map((task) => task.id) },
			)
		}

		if (current && (current.status === "TODO" || current.status === "IN_PROGRESS")) {
			return skip(
				`implementation unit ${current.id} is still ${current.status}; resuming instead of reassigning`,
				"current-unit-unfinished",
				{ currentUnitStatus: current.status },
			)
		}

		const next = readyTasks(artifacts.tasks)[0]
		if (!next) {
			return skip(
				"no implementation unit is ready; every pending unit has an unfinished dependency",
				"no-ready-task",
				{ pendingUnits: artifacts.tasks.filter((task) => task.status === "TODO").map((task) => task.id) },
			)
		}

		const relativeArtifact = `implementation/${next.fileName}`
		const readmePath = path.join(context.taskRoot, "README.md")
		const readme = await this.fileSystem.readFile(readmePath, "utf8")
		const updated = this.writeAssignment(readme, relativeArtifact, next.id)

		if (updated === null) {
			return skip(
				"README has no canonical Status line; mutating an unrecognized layout is unsafe",
				"readme-layout-unrecognized",
				{ readmePath },
			)
		}

		const stateBefore = readCanonicalFields(readme)
		await this.writeAtomic(readmePath, updated)
		const stateAfter = readCanonicalFields(updated)

		const assignment: TaskAssignment = {
			task: next,
			relativeArtifact,
			replaced: current?.id ?? null,
			state: {
				taskId: state.taskId,
				status: "IMPLEMENTATION",
				currentTask: next.id,
				currentTaskArtifact: next.artifact,
			},
		}

		logger.decision("harness.scheduler.assignNext", {
			input: { ...input, readyUnits: readyTasks(artifacts.tasks).map((task) => task.id) },
			result: {
				taskId: next.id,
				relativeArtifact,
				replaced: assignment.replaced,
			},
			reason: `assigned the lowest-numbered ready implementation unit ${next.id}`,
			attributes: { reasonCode: "assigned", replaced: assignment.replaced },
			context: { taskId: state.taskId, txxId: next.id },
		})

		logger.mutation("harness.scheduler.assignNext", {
			target: readmePath,
			stateBefore,
			stateAfter,
			reason: `wrote the canonical assignment for ${next.id} into the task README`,
			attributes: { reasonCode: "assigned", relativeArtifact, replaced: assignment.replaced },
			context: { taskId: state.taskId, txxId: next.id },
		})

		return assignment
	}

	/**
	 * Rewrite the canonical README fields. Returns `null` when the README has no
	 * canonical `Status` line, because mutating an unrecognized layout is unsafe.
	 */
	private writeAssignment(readme: string, relativeArtifact: string, taskId: string): string | null {
		const lines = readme.split(/\r?\n/)

		const setField = (name: string, value: string): boolean => {
			const prefix = `${name.toLowerCase()}:`
			const index = lines.findIndex((line) => line.trim().toLowerCase().startsWith(prefix))
			if (index === -1) {
				return false
			}
			lines[index] = `${name}: ${value}`
			return true
		}

		if (!setField("Status", "IMPLEMENTATION")) {
			return null
		}

		if (!setField("Current Task", relativeArtifact)) {
			const statusIndex = lines.findIndex((line) => line.trim().toLowerCase().startsWith("status:"))
			lines.splice(statusIndex + 1, 0, `Current Task: ${relativeArtifact}`)
		}

		setField("Next Step", `Implement ${taskId} (${relativeArtifact}).`)

		return lines.join("\n")
	}

	/**
	 * Write through a temporary file so a concurrent reader never observes a
	 * partially written README.
	 */
	private async writeAtomic(filePath: string, content: string): Promise<void> {
		const temporary = `${filePath}.${process.pid}.tmp`
		await this.fileSystem.writeFile(temporary, content, "utf8")
		await this.fileSystem.rename(temporary, filePath)
	}
}
