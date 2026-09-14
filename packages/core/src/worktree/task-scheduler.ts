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

export class TaskScheduler {
	constructor(
		private readonly fileSystem: TaskSchedulerFileSystem = fs,
		private readonly parser: TxxParser = new TxxParser(fileSystem),
	) {}

	/**
	 * Read-only view of the DAG. Safe to call on every task start.
	 */
	async plan(context: TaskContext): Promise<SchedulerPlan> {
		const artifacts = await this.parser.read(context)

		return {
			artifacts,
			ready: readyTasks(artifacts.tasks),
			inProgress: sortTasks(artifacts.tasks.filter((task) => task.status === "IN_PROGRESS")),
			done: sortTasks(artifacts.tasks.filter((task) => task.status === "DONE")),
			blocked: sortTasks(artifacts.tasks.filter((task) => task.status === "BLOCKED")),
		}
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
		if (state.status !== "IMPLEMENTATION" && state.status !== "READY_FOR_IMPLEMENTATION") {
			return null
		}

		const artifacts = await this.parser.read(context)
		const current = state.currentTask
			? (artifacts.tasks.find((task) => task.id === state.currentTask) ?? null)
			: null

		if (state.currentTask && !current) {
			return null
		}

		if (current && (current.status === "TODO" || current.status === "IN_PROGRESS")) {
			return null
		}

		const next = readyTasks(artifacts.tasks)[0]
		if (!next) {
			return null
		}

		const relativeArtifact = `implementation/${next.fileName}`
		const readmePath = path.join(context.taskRoot, "README.md")
		const readme = await this.fileSystem.readFile(readmePath, "utf8")
		const updated = this.writeAssignment(readme, relativeArtifact, next.id)

		if (updated === null) {
			return null
		}

		await this.writeAtomic(readmePath, updated)

		return {
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
