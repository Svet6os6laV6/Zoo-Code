/**
 * Canonical task README block
 *
 * The harness owns a small canonical block in the task README (`Status`,
 * `Current Task`, `Next Step`). Two modules mutate it — `TaskScheduler` when it
 * assigns an implementation unit and `ModeRunner` when a lifecycle stage moves
 * the status — so the field parsing, the field order, and the atomic write live
 * here instead of being reimplemented per caller.
 *
 * A caller never rewrites the whole README: it names the fields it owns and
 * everything else in the file is preserved byte for byte.
 */

import { promises as fs } from "fs"
import * as path from "path"

export const README_FILENAME = "README.md"

/** Canonical value declaring that no implementation unit is assigned. */
export const NO_CURRENT_TASK = "NONE"

/**
 * Canonical fields in the order a missing field is inserted. The `Status` line
 * is the anchor: a README without it is left untouched, because mutating an
 * unrecognized layout is unsafe.
 */
export const CANONICAL_README_FIELDS = ["Status", "Current Task", "Next Step"] as const

export type CanonicalReadmeField = (typeof CANONICAL_README_FIELDS)[number]

/** The subset of canonical fields a caller wants to write. */
export type CanonicalReadmeFields = Partial<Record<CanonicalReadmeField, string>>

/** Observed canonical values, used for the harness mutation records. */
export type CanonicalReadmeSnapshot = {
	readonly status: string | null
	readonly currentTask: string | null
	readonly nextStep: string | null
}

/** The file capabilities both the scheduler and the lifecycle runner need. */
export type ReadmeFileSystem = {
	readFile(filePath: string, encoding: "utf8"): Promise<string>
	writeFile(filePath: string, data: string, encoding: "utf8"): Promise<void>
	rename(oldPath: string, newPath: string): Promise<void>
}

export type CanonicalReadmeUpdate = {
	readonly filePath: string
	readonly before: CanonicalReadmeSnapshot
	readonly after: CanonicalReadmeSnapshot
}

export class CanonicalReadmeError extends Error {
	override readonly name = "CanonicalReadmeError"
}

export function readmePath(taskRoot: string): string {
	return path.join(taskRoot, README_FILENAME)
}

function findFieldIndex(lines: readonly string[], name: string): number {
	const prefix = `${name.toLowerCase()}:`
	return lines.findIndex((line) => line.trim().toLowerCase().startsWith(prefix))
}

function readField(lines: readonly string[], name: string): string | null {
	const index = findFieldIndex(lines, name)
	if (index === -1) {
		return null
	}

	const line = lines[index] ?? ""
	return line.slice(line.indexOf(":") + 1).trim()
}

/**
 * Read-only view of the canonical block. Tolerant by design: it accepts any
 * casing and surrounding whitespace so a hand-edited README still reports what
 * the harness will rewrite.
 */
export function readCanonicalFields(readme: string): CanonicalReadmeSnapshot {
	const lines = readme.split(/\r?\n/)

	return {
		status: readField(lines, "Status"),
		currentTask: readField(lines, "Current Task"),
		nextStep: readField(lines, "Next Step"),
	}
}

/**
 * Rewrite the named canonical fields, preserving every other line.
 *
 * Returns `null` when the README has no canonical `Status` line. A field that is
 * absent from the README is inserted after the `Status` line in canonical order,
 * so the block stays readable instead of accumulating fields in arbitrary places.
 */
export function writeCanonicalFields(readme: string, fields: CanonicalReadmeFields): string | null {
	const lines = readme.split(/\r?\n/)
	const statusIndex = findFieldIndex(lines, "Status")
	if (statusIndex === -1) {
		return null
	}

	const inserted: string[] = []

	for (const name of CANONICAL_README_FIELDS) {
		const value = fields[name]
		if (value === undefined) {
			continue
		}

		const index = findFieldIndex(lines, name)
		if (index === -1) {
			inserted.push(`${name}: ${value}`)
			continue
		}

		lines[index] = `${name}: ${value}`
	}

	if (inserted.length > 0) {
		lines.splice(statusIndex + 1, 0, ...inserted)
	}

	return lines.join("\n")
}

/**
 * Write through a temporary file so a concurrent reader never observes a
 * partially written README.
 */
export async function writeReadmeAtomic(
	fileSystem: ReadmeFileSystem,
	filePath: string,
	content: string,
): Promise<void> {
	const temporary = `${filePath}.${process.pid}.tmp`
	await fileSystem.writeFile(temporary, content, "utf8")
	await fileSystem.rename(temporary, filePath)
}

/**
 * Read-modify-write of the canonical block for callers that own the mutation
 * outright (the lifecycle runner). Callers that must decide *whether* to mutate
 * from the raw text use the free functions above instead.
 */
export class CanonicalReadmeWriter {
	constructor(private readonly fileSystem: ReadmeFileSystem = fs) {}

	async update(taskRoot: string, fields: CanonicalReadmeFields): Promise<CanonicalReadmeUpdate> {
		const filePath = readmePath(taskRoot)
		const readme = await this.fileSystem.readFile(filePath, "utf8")
		const updated = writeCanonicalFields(readme, fields)

		if (updated === null) {
			throw new CanonicalReadmeError(`Cannot update the canonical block without a Status field: ${filePath}`)
		}

		await writeReadmeAtomic(this.fileSystem, filePath, updated)

		return { filePath, before: readCanonicalFields(readme), after: readCanonicalFields(updated) }
	}
}
