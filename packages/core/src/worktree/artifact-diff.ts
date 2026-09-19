/**
 * ArtifactDiff
 *
 * Change detection between two consecutive implementation-artifact snapshots.
 *
 * The harness only sees the parsed view of the artifacts, so a mutation made by
 * the model (or by a tool acting for it) is invisible between two resolves: the
 * log jumps from `T01 = IN_PROGRESS` straight to `T01 = DONE`. This module turns
 * two snapshots into the concrete list of what changed, which the harness records
 * as `harness.artifact.changed` and `harness.taskUnit.statusChanged`.
 *
 * Pure: no filesystem, no logger, no side effects.
 */

import type { ImplementationArtifacts, ImplementationTaskStatus } from "./txx-parser.js"

/** One implementation unit whose parsed `Status` moved between two snapshots. */
export type TaskUnitStatusChange = {
	readonly id: string
	/** `null` when the unit did not exist in the previous snapshot. */
	readonly from: ImplementationTaskStatus | null
	readonly to: ImplementationTaskStatus | null
}

export type ArtifactSnapshotDiff = {
	/** Units present in both snapshots whose raw content changed. */
	readonly rewrittenUnits: readonly string[]
	readonly addedUnits: readonly string[]
	readonly removedUnits: readonly string[]
	readonly statusChanges: readonly TaskUnitStatusChange[]
	/** True when the artifact set differs at all, ignoring pure status moves. */
	readonly changed: boolean
}

const NO_CHANGES: ArtifactSnapshotDiff = {
	rewrittenUnits: [],
	addedUnits: [],
	removedUnits: [],
	statusChanges: [],
	changed: false,
}

/**
 * Compare the current snapshot with the previous one.
 *
 * A missing baseline (the first resolve of a task run) produces no changes: the
 * first snapshot establishes the baseline, it is not itself a change.
 */
export function diffImplementationArtifacts(
	previous: ImplementationArtifacts | null,
	next: ImplementationArtifacts,
): ArtifactSnapshotDiff {
	if (!previous) {
		return NO_CHANGES
	}

	const previousById = new Map(previous.tasks.map((task) => [task.id, task]))
	const rewrittenUnits: string[] = []
	const addedUnits: string[] = []
	const statusChanges: TaskUnitStatusChange[] = []

	for (const task of next.tasks) {
		const before = previousById.get(task.id)

		if (!before) {
			addedUnits.push(task.id)
			statusChanges.push({ id: task.id, from: null, to: task.status })
			continue
		}

		if (before.contentHash !== task.contentHash) {
			rewrittenUnits.push(task.id)
		}

		if (before.status !== task.status) {
			statusChanges.push({ id: task.id, from: before.status, to: task.status })
		}
	}

	const nextIds = new Set(next.tasks.map((task) => task.id))
	const removedUnits = previous.tasks.filter((task) => !nextIds.has(task.id)).map((task) => task.id)

	return {
		rewrittenUnits,
		addedUnits,
		removedUnits,
		statusChanges,
		changed: rewrittenUnits.length > 0 || addedUnits.length > 0 || removedUnits.length > 0,
	}
}
