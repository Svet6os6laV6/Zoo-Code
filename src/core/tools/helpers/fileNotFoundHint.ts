/**
 * Helpers for producing actionable "file not found" hints.
 *
 * When a model requests a file that does not exist (typically because it
 * hallucinated or mistyped the filename), returning only the raw ENOENT
 * message forces another blind guess. These helpers inspect the nearest
 * existing ancestor directory and suggest the closest matching entries so the
 * model can self-correct in a single step.
 */
import * as fs from "fs/promises"
import path from "path"

const DEFAULT_MAX_SUGGESTIONS = 5
const DEFAULT_MIN_SCORE = 0.3

export interface NotFoundHintOptions {
	/** Maximum number of suggestions to include. Defaults to 5. */
	maxSuggestions?: number
	/** Minimum similarity score (0..1) for an entry to be suggested. Defaults to 0.3. */
	minScore?: number
}

/**
 * Returns true when the error represents a missing file/directory (ENOENT).
 */
export function isNotFoundError(error: unknown): boolean {
	if (!error || typeof error !== "object") {
		return false
	}

	const code = (error as NodeJS.ErrnoException).code
	if (code === "ENOENT") {
		return true
	}

	const message = error instanceof Error ? error.message : String(error)
	return message.includes("ENOENT")
}

/**
 * Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
	const m = a.length
	const n = b.length

	if (m === 0) return n
	if (n === 0) return m

	let prev = new Array<number>(n + 1)
	let curr = new Array<number>(n + 1)

	for (let j = 0; j <= n; j++) {
		prev[j] = j
	}

	for (let i = 1; i <= m; i++) {
		curr[0] = i
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
		}
		const swap = prev
		prev = curr
		curr = swap
	}

	return prev[n]
}

/**
 * Normalized similarity in the range [0, 1] (1 = identical, case-insensitive).
 */
export function similarityScore(a: string, b: string): number {
	const maxLen = Math.max(a.length, b.length)
	if (maxLen === 0) {
		return 1
	}
	return 1 - levenshteinDistance(a.toLowerCase(), b.toLowerCase()) / maxLen
}

/**
 * Walk up from `startDir` until an existing directory is found.
 *
 * Returns the directory, its entries (directories suffixed with "/"), and the
 * path segment that was missing beneath it. When the immediate parent exists,
 * `missingSegment` is the requested file name; when we had to walk up, it is
 * the first missing directory segment.
 */
async function findNearestExistingDirectory(
	startDir: string,
	requestedName: string,
): Promise<{ dir: string | null; entries: string[]; missingSegment: string }> {
	let current = startDir
	let missingSegment = requestedName

	while (true) {
		try {
			const dirents = await fs.readdir(current, { withFileTypes: true })
			const entries = dirents.map((dirent) => (dirent.isDirectory() ? `${dirent.name}/` : dirent.name))
			return { dir: current, entries, missingSegment }
		} catch {
			const parent = path.dirname(current)
			if (parent === current) {
				return { dir: null, entries: [], missingSegment }
			}
			missingSegment = path.basename(current)
			current = parent
		}
	}
}

/**
 * Build a human-readable hint listing the closest matching entries in the
 * nearest existing ancestor directory.
 *
 * Returns an empty string when the error is not a not-found error or no useful
 * context can be gathered (so callers can safely append the result).
 */
export async function buildFileNotFoundHint(
	relPath: string,
	fullPath: string,
	cwd: string,
	error: unknown,
	options: NotFoundHintOptions = {},
): Promise<string> {
	if (!isNotFoundError(error)) {
		return ""
	}

	const maxSuggestions = options.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS
	const minScore = options.minScore ?? DEFAULT_MIN_SCORE

	try {
		const { dir, entries, missingSegment } = await findNearestExistingDirectory(
			path.dirname(fullPath),
			path.basename(fullPath),
		)

		if (!dir) {
			return ""
		}

		const dirLabel = path.relative(cwd, dir) || "."

		const scored = entries
			.map((name) => ({ name, score: similarityScore(missingSegment, name.replace(/\/$/, "")) }))
			.filter((entry) => entry.score >= minScore)
			.sort((a, b) => b.score - a.score)
			.slice(0, maxSuggestions)

		if (scored.length === 0) {
			return `\n\nHint: '${relPath}' was not found. The directory '${dirLabel}' exists but has no similar entries. Use the list_files tool to inspect it.`
		}

		const suggestions = scored.map((entry) => `- ${entry.name}`).join("\n")
		return `\n\nHint: '${relPath}' was not found. Similar entries in '${dirLabel}':\n${suggestions}`
	} catch {
		return ""
	}
}
