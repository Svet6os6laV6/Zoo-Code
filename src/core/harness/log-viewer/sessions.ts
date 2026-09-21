/**
 * Harness log session history.
 *
 * Reads the JSONL session files written by `JsonlSink` into
 * `<storageBase>/harness-logs`: one `<sessionId>.jsonl` per session plus up to
 * three rotations (`<sessionId>.jsonl.1` … `.3`, oldest content first).
 *
 * Record indices are stable across requests: only parseable JSON lines occupy
 * an index, so a corrupted tail line never shifts pagination.
 */

import * as fs from "fs/promises"
import type { Dirent } from "fs"
import * as path from "path"

export const DEFAULT_SESSION_RECORDS_LIMIT = 500
export const MAX_SESSION_RECORDS_LIMIT = 5_000

export type HarnessLogSessionSummary = {
	/** File name without the `.jsonl` extension; used as the API session id. */
	readonly id: string
	readonly fileName: string
	/** Size of the active `<id>.jsonl` file in bytes (rotations not included). */
	readonly sizeBytes: number
	/** ISO timestamp of the active file's last modification. */
	readonly modifiedAt: string
	/** True for the session id of the current harness run. */
	readonly active: boolean
}

export type SessionRecordsPage = {
	readonly records: unknown[]
	/** Index to pass as `after` for the next page; null when there are no more records. */
	readonly nextAfter: number | null
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const JSONL_EXTENSION = ".jsonl"

/**
 * Session ids come from file names, so they are validated before any file
 * system access: no path separators, no `..` traversal, no empty ids.
 */
export function isValidSessionId(id: string): boolean {
	if (id.length === 0 || id.includes("..") || id.includes("/") || id.includes("\\")) {
		return false
	}

	return SESSION_ID_PATTERN.test(id)
}

export async function listSessions(
	logsDirectory: string,
	activeSessionId: string,
): Promise<HarnessLogSessionSummary[]> {
	let entries: Dirent[]

	try {
		entries = await fs.readdir(logsDirectory, { withFileTypes: true })
	} catch {
		// No directory (or no access) = no history yet.
		return []
	}

	const sessions: Array<{ summary: HarnessLogSessionSummary; mtimeMs: number }> = []

	for (const entry of entries) {
		// Rotations (`<id>.jsonl.1`…) do not end with `.jsonl`, so this keeps
		// only the active session files.
		if (!entry.isFile() || !entry.name.endsWith(JSONL_EXTENSION)) {
			continue
		}

		const id = entry.name.slice(0, -JSONL_EXTENSION.length)

		if (!isValidSessionId(id)) {
			continue
		}

		try {
			const stat = await fs.stat(path.join(logsDirectory, entry.name))
			sessions.push({
				summary: {
					id,
					fileName: entry.name,
					sizeBytes: stat.size,
					modifiedAt: new Date(stat.mtimeMs).toISOString(),
					active: id === activeSessionId,
				},
				mtimeMs: stat.mtimeMs,
			})
		} catch {
			// The file vanished between readdir and stat: skip it.
		}
	}

	sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)

	return sessions.map((session) => session.summary)
}

export async function readSessionRecords(
	logsDirectory: string,
	sessionId: string,
	options: { after?: number; limit?: number } = {},
): Promise<SessionRecordsPage | undefined> {
	if (!isValidSessionId(sessionId)) {
		return undefined
	}

	const after = Math.max(0, Math.floor(options.after ?? 0))
	const limit = Math.min(
		MAX_SESSION_RECORDS_LIMIT,
		Math.max(1, Math.floor(options.limit ?? DEFAULT_SESSION_RECORDS_LIMIT)),
	)

	// Oldest rotation first, the active file last: record order is chronological.
	const fileNames = [`${sessionId}.jsonl.3`, `${sessionId}.jsonl.2`, `${sessionId}.jsonl.1`, `${sessionId}.jsonl`]

	const records: unknown[] = []

	for (const fileName of fileNames) {
		try {
			records.push(...parseRecordLines(await fs.readFile(path.join(logsDirectory, fileName), "utf8")))
		} catch {
			// A missing rotation (or a missing session file) is not an error.
		}
	}

	const page = records.slice(after, after + limit)

	return {
		records: page,
		nextAfter: after + page.length < records.length ? after + page.length : null,
	}
}

/**
 * Parses the JSONL body of one file. Blank and corrupted lines (for example a
 * truncated tail) are skipped without consuming a record index, so pagination
 * stays stable even when the last write was interrupted.
 */
function parseRecordLines(content: string): unknown[] {
	const records: unknown[] = []

	for (const line of content.split("\n")) {
		if (line.length === 0) {
			continue
		}

		try {
			records.push(JSON.parse(line))
		} catch {
			// Corrupted line: skip it.
		}
	}

	return records
}
