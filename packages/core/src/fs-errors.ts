/**
 * Shared filesystem error predicates.
 *
 * One definition of "the path was missing" so the artifact parser, the state
 * resolver, and the log sink cannot drift apart on which errors they tolerate.
 */

/** True when the error is a Node `ENOENT` (path does not exist). */
export function isFileNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}
