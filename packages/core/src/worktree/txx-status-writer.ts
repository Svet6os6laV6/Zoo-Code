/**
 * Implementation unit status writer
 *
 * The harness owns the machine-readable `Status` field of an implementation unit
 * artifact (`implementation/Txx-*.md`); the model owns the prose around it. When
 * an assigned unit turns out not to be ready (a dependency on another unit was
 * discovered), the unit is *parked*: only its status field is rewritten from
 * `IN_PROGRESS` back to `TODO`, and every other byte is preserved.
 *
 * Both artifact layouts the parser accepts are supported — the protocol v2
 * `## Status` section and YAML frontmatter — and the writer rewrites whichever
 * field the parser would read, so the two cannot disagree.
 */

import { promises as fs } from "fs"

import { harnessLogger } from "../observability/harness-logger.js"
import type { HarnessLoggerPort } from "../observability/types.js"

import { writeReadmeAtomic, type ReadmeFileSystem } from "./task-readme.js"

/** The only status a park rewrites; every other value is left untouched. */
const PARKED_FROM = "IN_PROGRESS"
const PARKED_TO = "TODO"

export type ParkImplementationTaskResult =
	| {
			readonly type: "parked"
			readonly filePath: string
			readonly before: string
			readonly after: string
	  }
	| {
			readonly type: "unchanged"
			readonly filePath: string
			readonly status: string | null
			readonly reason: "no-status-field" | "not-in-progress"
	  }

const FRONTMATTER_STATUS_PATTERN = /^(\s*status\s*:\s*)(.*)$/i
const SECTION_STATUS_PATTERN = /^(\s*(?:[-*+]\s+)?status\s*:\s*)(.*)$/i
const HEADING_PATTERN = /^#{1,6}\s/

/**
 * Bounds of the YAML frontmatter block, or `null` when the artifact has none.
 */
function frontmatterBounds(lines: readonly string[]): { start: number; end: number } | null {
	if ((lines[0] ?? "").trim() !== "---") {
		return null
	}

	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
	return end === -1 ? null : { start: 0, end }
}

/**
 * Index of the `Status` line the parser would read, mirroring its precedence:
 * frontmatter `status` first, then the first `Status:` line of the `## Status`
 * section.
 */
function findStatusLine(lines: readonly string[]): number {
	const frontmatter = frontmatterBounds(lines)
	if (frontmatter) {
		for (let index = frontmatter.start + 1; index < frontmatter.end; index += 1) {
			if (FRONTMATTER_STATUS_PATTERN.test(lines[index] ?? "")) {
				return index
			}
		}
	}

	const headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === "## status")
	if (headingIndex === -1) {
		return -1
	}

	for (let index = headingIndex + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? ""
		if (HEADING_PATTERN.test(line)) {
			break
		}
		if (SECTION_STATUS_PATTERN.test(line)) {
			return index
		}
	}

	return -1
}

/**
 * Park an assigned implementation unit: `IN_PROGRESS` → `TODO`.
 *
 * Returns `unchanged` when there is nothing to park (no status field, or the
 * unit is not `IN_PROGRESS`), so the caller can proceed with the DAG recompute
 * without treating a benign no-op as a failure. The write is atomic, so a
 * concurrent reader never observes a partially written artifact.
 */
export async function parkImplementationTask(
	fileSystem: ReadmeFileSystem = fs,
	artifactPath: string,
	logger?: HarnessLoggerPort,
): Promise<ParkImplementationTaskResult> {
	const log = harnessLogger(logger)
	const content = await fileSystem.readFile(artifactPath, "utf8")
	const lines = content.split(/\r?\n/)
	const index = findStatusLine(lines)

	if (index === -1) {
		log.decision("harness.txx.park", {
			input: { artifactPath },
			result: null,
			reason: "implementation unit has no Status field to park",
			attributes: { reasonCode: "no-status-field" },
		})
		return { type: "unchanged", filePath: artifactPath, status: null, reason: "no-status-field" }
	}

	const line = lines[index] ?? ""
	const match = FRONTMATTER_STATUS_PATTERN.exec(line) ?? SECTION_STATUS_PATTERN.exec(line)
	const prefix = match?.[1] ?? ""
	const current = (match?.[2] ?? "").trim().toUpperCase()

	if (current !== PARKED_FROM) {
		log.decision("harness.txx.park", {
			input: { artifactPath, status: current || null },
			result: null,
			reason: `implementation unit is ${current || "unreadable"}; only ${PARKED_FROM} is parked`,
			attributes: { reasonCode: "not-in-progress", status: current || null },
		})
		return { type: "unchanged", filePath: artifactPath, status: current || null, reason: "not-in-progress" }
	}

	lines[index] = `${prefix}${PARKED_TO}`
	const updated = lines.join("\n")
	await writeReadmeAtomic(fileSystem, artifactPath, updated)

	log.mutation("harness.txx.park", {
		target: artifactPath,
		stateBefore: { status: PARKED_FROM },
		stateAfter: { status: PARKED_TO },
		reason: "parked the assigned implementation unit so the scheduler can recompute the DAG",
		attributes: { reasonCode: "parked" },
	})

	return { type: "parked", filePath: artifactPath, before: content, after: updated }
}
