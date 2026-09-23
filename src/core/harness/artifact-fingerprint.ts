/**
 * ArtifactFingerprint
 *
 * Content fingerprint of the harness-owned task artifacts: the canonical
 * `README.md` plus the parsed `implementation/*.md` snapshot.
 *
 * `Task.resolveTaskState` runs on every API request (each tool result starts a
 * new request, and every request rebuilds the system prompt). When neither the
 * README nor the implementation artifacts changed since the previous resolve,
 * the outcome is deterministic: the validator and the scheduler would only
 * re-emit the same decision records. This module turns the two inputs into a
 * single comparable value so the caller can short-circuit that work.
 *
 * Pure: no filesystem, no logger, no side effects.
 */

import { createHash } from "crypto"

import type { ImplementationArtifacts } from "@roo-code/core"

export type ArtifactFingerprintInput = {
	/** Raw canonical README content, or `null` when it could not be read. */
	readonly readme: string | null
	readonly snapshot: ImplementationArtifacts
}

/**
 * Stable fingerprint of the artifact state.
 *
 * The README is compared byte for byte, so any edit (including a harness-owned
 * `Status`/`Current Task` write) invalidates the fingerprint. Implementation
 * units are compared by identity, file name, and raw content hash, so a status
 * move, a rewrite, an add, or a remove all change the result. Directory-level
 * facts the validator consumes (`missingDirectory`, `duplicateIds`,
 * `unexpectedFiles`) are included as well.
 *
 * Arrays are sorted before hashing so a different `readdir` order does not
 * produce a spurious miss.
 */
export function computeArtifactFingerprint(input: ArtifactFingerprintInput): string {
	const normalized = {
		readme: input.readme,
		missingDirectory: input.snapshot.missingDirectory,
		duplicateIds: [...input.snapshot.duplicateIds].sort(),
		unexpectedFiles: [...input.snapshot.unexpectedFiles].sort(),
		tasks: [...input.snapshot.tasks]
			.map((task) => ({ id: task.id, fileName: task.fileName, contentHash: task.contentHash }))
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
	}

	return createHash("sha1").update(JSON.stringify(normalized), "utf8").digest("hex")
}
