/**
 * StateReconciler
 *
 * Diagnostic comparison between the runtime view of a task and its canonical
 * artifacts.
 *
 * The harness keeps a `TaskState` in memory (README-derived, then possibly
 * advanced by a scheduler assignment) while the README and the `implementation/`
 * artifacts remain the source of truth. Whenever those two drift — a concurrent
 * writer, a partially applied assignment, a hand-edited README — the drift is
 * silent today. This reconciler makes it visible.
 *
 * Contract:
 * - read-only: it never writes, never repairs, never advances the lifecycle;
 * - non-throwing: every failure (unreadable README, malformed artifacts) is
 *   reported as a difference, because the caller is mid-flight and a diagnostic
 *   must not change the outcome of the operation it observes.
 */

import { promises as fs } from "fs"

import type { TaskContext } from "../worktree/task-resolver.js"
import { TaskStateResolver, isActiveAssignment, type TaskState } from "../worktree/task-state.js"
import { TxxParser, type ImplementationArtifacts, type ImplementationFileSystem } from "../worktree/txx-parser.js"

import { getRootHarnessLogger } from "./harness-logger.js"
import type { HarnessLogContextInput, HarnessLoggerPort } from "./types.js"

export type StateReconcilerFileSystem = ImplementationFileSystem

export type StateDifference = {
	/** Stable field name, for example `status` or `currentTask-unit`. */
	readonly field: string
	readonly runtime: unknown
	readonly canonical: unknown
	readonly message: string
}

export type StateReconciliation = {
	/** Call site that triggered the check, for example `scheduler.assignNext`. */
	readonly phase: string
	readonly consistent: boolean
	readonly differences: readonly StateDifference[]
	/** Canonical state, or `null` when the README could not be resolved. */
	readonly canonical: TaskState | null
}

/**
 * Executor lease observed by the caller.
 *
 * The reconciler never reads the task history, so the caller supplies both the
 * canonical `Owner` value (as `mode`/`agentTaskId`) and whether that task is
 * currently active. `mode`/`agentTaskId` are `null` when the canonical README has
 * no `Owner` field.
 */
export type AssignmentOwnerContext = {
	readonly mode: string | null
	readonly agentTaskId: string | null
	readonly active: boolean
}

export type StateReconcileOptions = {
	readonly phase?: string
	/** Overrides the constructor logger for this call. */
	readonly logger?: HarnessLoggerPort
	readonly context?: HarnessLogContextInput
	/**
	 * Executor lease to check against the runtime assignment. When omitted the
	 * owner check is skipped, so callers that do not track the lease keep the
	 * previous behaviour.
	 */
	readonly owner?: AssignmentOwnerContext
}

const DEFAULT_PHASE = "unspecified"

function difference(field: string, runtime: unknown, canonical: unknown, message: string): StateDifference {
	return { field, runtime, canonical, message }
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/** Field-by-field comparison of two resolved states. Exported for tests. */
export function diffTaskState(runtime: TaskState, canonical: TaskState): readonly StateDifference[] {
	const differences: StateDifference[] = []

	if (runtime.status !== canonical.status) {
		differences.push(
			difference(
				"status",
				runtime.status,
				canonical.status,
				`runtime status ${runtime.status} does not match canonical status ${canonical.status}`,
			),
		)
	}

	if (runtime.currentTask !== canonical.currentTask) {
		differences.push(
			difference(
				"currentTask",
				runtime.currentTask,
				canonical.currentTask,
				`runtime implementation unit ${runtime.currentTask ?? "NONE"} does not match canonical ${
					canonical.currentTask ?? "NONE"
				}`,
			),
		)
	}

	if (runtime.currentTaskArtifact !== canonical.currentTaskArtifact) {
		differences.push(
			difference(
				"currentTaskArtifact",
				runtime.currentTaskArtifact,
				canonical.currentTaskArtifact,
				"runtime artifact path does not match the canonical README path",
			),
		)
	}

	return differences
}

export class StateReconciler {
	constructor(
		private readonly fileSystem: StateReconcilerFileSystem = fs,
		private readonly parser: TxxParser = new TxxParser(fileSystem),
		private readonly stateResolver: TaskStateResolver = new TaskStateResolver(fileSystem),
		private readonly logger?: HarnessLoggerPort,
	) {}

	/**
	 * Compares `runtime` with the canonical README and the parsed implementation
	 * artifacts, logs the result, and returns it. Never throws.
	 */
	async reconcile(
		context: TaskContext,
		runtime: TaskState,
		options: StateReconcileOptions = {},
	): Promise<StateReconciliation> {
		const phase = options.phase ?? DEFAULT_PHASE
		const differences: StateDifference[] = []
		let canonical: TaskState | null = null
		let artifacts: ImplementationArtifacts | null = null

		try {
			canonical = await this.stateResolver.resolve(context)
		} catch (error) {
			differences.push(
				difference(
					"canonical-readme",
					runtime.status,
					null,
					`canonical README could not be resolved: ${describeError(error)}`,
				),
			)
		}

		if (canonical) {
			differences.push(...diffTaskState(runtime, canonical))
		}

		try {
			artifacts = await this.parser.read(context)
		} catch (error) {
			differences.push(
				difference(
					"implementation-artifacts",
					runtime.currentTask,
					null,
					`implementation artifacts could not be parsed: ${describeError(error)}`,
				),
			)
		}

		if (artifacts && runtime.currentTask) {
			const unit = artifacts.tasks.find((task) => task.id === runtime.currentTask)

			if (!unit) {
				differences.push(
					difference(
						"currentTask-unit",
						runtime.currentTask,
						artifacts.tasks.map((task) => task.id),
						`implementation unit ${runtime.currentTask} is assigned but missing from implementation/`,
					),
				)
			} else if (unit.statusProblem) {
				differences.push(
					difference(
						"currentTask-unit-status",
						runtime.currentTask,
						unit.status,
						`implementation unit ${runtime.currentTask} has an unusable status: ${unit.statusProblem}`,
					),
				)
			}

			// Ownerless assignment: the runtime shows a unit being executed, but the
			// canonical `Owner` lease is absent or its task is not active. The caller
			// supplies the lease and the activity flag, so the check stays read-only
			// and non-throwing. A unit that is already `DONE` is finishing, not
			// executing, so it is not reported.
			if (options.owner && isActiveAssignment(runtime.status, runtime.currentTask, unit?.status)) {
				const owner = options.owner
				const ownerPresent = owner.mode !== null && owner.agentTaskId !== null

				if (!ownerPresent || !owner.active) {
					differences.push(
						difference(
							"assignment-owner",
							runtime.currentTask,
							ownerPresent ? `${owner.mode}#${owner.agentTaskId}` : null,
							ownerPresent
								? `implementation unit ${runtime.currentTask} is assigned but its owner ${owner.mode}#${owner.agentTaskId} is not active`
								: `implementation unit ${runtime.currentTask} is assigned but no executor owns it`,
						),
					)
				}
			}
		}

		const reconciliation: StateReconciliation = {
			phase,
			consistent: differences.length === 0,
			differences,
			canonical,
		}

		const logger = options.logger ?? this.logger ?? getRootHarnessLogger()
		logger.event("harness.state.reconcile", {
			level: reconciliation.consistent ? "debug" : "warn",
			context: {
				taskId: context.taskId,
				txxId: runtime.currentTask,
				...(options.context ?? {}),
			},
			attributes: {
				phase,
				consistent: reconciliation.consistent,
				differenceCount: differences.length,
				differences,
				owner: options.owner ?? null,
				runtime: {
					status: runtime.status,
					currentTask: runtime.currentTask,
					currentTaskArtifact: runtime.currentTaskArtifact,
				},
				canonical: canonical
					? {
							status: canonical.status,
							currentTask: canonical.currentTask,
							currentTaskArtifact: canonical.currentTaskArtifact,
						}
					: null,
			},
		})

		return reconciliation
	}
}
