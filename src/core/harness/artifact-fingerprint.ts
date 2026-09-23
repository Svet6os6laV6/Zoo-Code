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

/**
 * Filesystem metadata of a single artifact file. `mtimeMs`/`size` are `null`
 * when the platform could not report them, which the fingerprint treats as
 * "unknown" rather than as a value.
 */
export type ArtifactStatEntry = {
	/** File name (basename) the metadata belongs to. */
	readonly name: string
	/** Modification time in milliseconds, or `null` when unavailable. */
	readonly mtimeMs: number | null
	/** Size in bytes, or `null` when unavailable. */
	readonly size: number | null
}

export type ArtifactStatFingerprintInput = {
	/** Stat of the canonical README, or `null` when it could not be read. */
	readonly readme: ArtifactStatEntry | null
	/**
	 * Stat of the `implementation/` markdown files, or `null` when the directory
	 * could not be read. An empty array is a valid, readable empty directory.
	 */
	readonly implementation: readonly ArtifactStatEntry[] | null
}

/**
 * Cheap fingerprint of the artifact state from file metadata only.
 *
 * `computeArtifactFingerprint` can only run after every `implementation/*.md`
 * has been parsed, so it saves the validator/scheduler work but not the parse.
 * This fingerprint is built from the README stat plus the name, `mtimeMs`, and
 * `size` of the implementation markdown files, so an unchanged artifact set can
 * be recognised before the parse.
 *
 * Returns `null` — "unknown, fall back to the full path" — whenever the input
 * cannot be trusted: a missing README, an unreadable directory, or a missing
 * stat field. Correctness is preferred over speed, so any doubt is a miss.
 *
 * The entries are sorted by name so a different `readdir` order does not
 * produce a spurious miss. `size` is included alongside `mtimeMs` so a
 * same-tick edit that changes the byte count is still detected.
 */
export function computeArtifactStatFingerprint(input: ArtifactStatFingerprintInput): string | null {
	if (input.readme === null || input.implementation === null) {
		return null
	}

	if (input.readme.mtimeMs === null || input.readme.size === null) {
		return null
	}

	const entries = [...input.implementation].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

	for (const entry of entries) {
		if (entry.mtimeMs === null || entry.size === null) {
			return null
		}
	}

	const normalized = {
		readme: { mtimeMs: input.readme.mtimeMs, size: input.readme.size },
		implementation: entries.map((entry) => ({ name: entry.name, mtimeMs: entry.mtimeMs, size: entry.size })),
	}

	return createHash("sha1").update(JSON.stringify(normalized), "utf8").digest("hex")
}
