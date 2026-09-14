/**
 * TxxParser
 *
 * Structural parser for implementation unit artifacts (`implementation/Txx-*.md`).
 *
 * The harness needs a programmatic view of the dependency DAG that the Architect
 * describes in Markdown. This module extracts the durable fields only:
 * `Status`, `Depends on`, `Parallel with`, `Produces`, and `Consumes`.
 *
 * Parsing is deliberately tolerant. A malformed field is reported through
 * `statusProblem` or an empty dependency list instead of throwing, so the
 * artifact validator can surface precise, actionable errors to the model.
 *
 * Both artifact layouts are supported:
 * - protocol v2 sections (`## Status`, `## Relationships`);
 * - YAML frontmatter (`status`, `depends_on`, `parallel_with`).
 */

import { promises as fs } from "fs"
import * as path from "path"

import type { TaskContext } from "./task-resolver.js"

const TASK_ID_PATTERN = /T\d{2,}/g
const TASK_FILE_NAME_PATTERN = /^(T\d{2,})(?:-[^/]+)?\.md$/
const IMPLEMENTATION_DIRECTORY = "implementation"

export const IMPLEMENTATION_TASK_STATUSES = ["TODO", "IN_PROGRESS", "DONE", "BLOCKED"] as const

export type ImplementationTaskStatus = (typeof IMPLEMENTATION_TASK_STATUSES)[number]

export type ImplementationTask = {
	readonly id: string
	readonly fileName: string
	readonly artifact: string
	readonly status: ImplementationTaskStatus | null
	/** Human-readable reason when `status` is null (missing or invalid). */
	readonly statusProblem: string | null
	readonly dependsOn: readonly string[]
	readonly parallelWith: readonly string[]
	readonly produces: string | null
	readonly consumes: string | null
	/** True when the artifact has an odd number of markdown code fences (truncated file). */
	readonly unclosedCodeFence: boolean
}

export type ImplementationArtifacts = {
	readonly directory: string
	readonly missingDirectory: boolean
	readonly tasks: readonly ImplementationTask[]
	readonly duplicateIds: readonly string[]
	/** Markdown files in the implementation directory that are not Txx artifacts. */
	readonly unexpectedFiles: readonly string[]
}

export type ImplementationFileSystem = {
	readFile(filePath: string, encoding: "utf8"): Promise<string>
	readdir(dirPath: string): Promise<string[]>
}

type Frontmatter = {
	readonly values: ReadonlyMap<string, string>
	readonly lists: ReadonlyMap<string, readonly string[]>
}

export function isFileNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

/**
 * A truncated artifact has an odd number of code fences, which breaks every
 * section that follows the unclosed block.
 */
export function hasUnclosedCodeFence(content: string): boolean {
	const fences = content.split(/\r?\n/).filter((line) => line.trim().startsWith("```")).length
	return fences % 2 !== 0
}

function isImplementationTaskStatus(value: string): value is ImplementationTaskStatus {
	return IMPLEMENTATION_TASK_STATUSES.some((status) => status === value)
}

/**
 * Extract the body of a `## <heading>` section, stopping at the next heading.
 */
function readSection(content: string, heading: string): string | null {
	const lines = content.split(/\r?\n/)
	const target = `## ${heading}`.toLowerCase()
	const start = lines.findIndex((line) => line.trim().toLowerCase() === target)

	if (start === -1) {
		return null
	}

	const body: string[] = []
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? ""
		if (/^#{1,6}\s/.test(line)) {
			break
		}
		body.push(line)
	}

	return body.join("\n")
}

/**
 * Read the first `Name: value` line of a section.
 *
 * Relationship fields are written as list items (`- Depends on: T01`), so a
 * leading list marker is stripped before matching.
 */
function readField(section: string | null, name: string): string | null {
	if (!section) {
		return null
	}

	const prefix = `${name}:`.toLowerCase()
	const line = section
		.split(/\r?\n/)
		.map((candidate) => candidate.trim().replace(/^[-*+]\s+/, ""))
		.find((candidate) => candidate.toLowerCase().startsWith(prefix))

	if (!line) {
		return null
	}

	const value = line.slice(prefix.length).trim()
	return value.length > 0 ? value : null
}

function parseFrontmatter(content: string): Frontmatter | null {
	const lines = content.split(/\r?\n/)
	if ((lines[0] ?? "").trim() !== "---") {
		return null
	}

	const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---")
	if (end === -1) {
		return null
	}

	const values = new Map<string, string>()
	const lists = new Map<string, string[]>()
	let currentList: string | null = null

	for (const line of lines.slice(1, end)) {
		const item = /^\s*-\s+(.+)$/.exec(line)
		if (item && currentList) {
			const value = item[1]
			if (value) {
				lists.get(currentList)?.push(value.trim())
			}
			continue
		}

		const field = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
		if (!field) {
			continue
		}

		const key = (field[1] ?? "").toLowerCase()
		const value = (field[2] ?? "").trim()

		if (value.length === 0) {
			currentList = key
			lists.set(key, [])
			continue
		}

		currentList = null
		values.set(key, value)
	}

	return { values, lists }
}

/**
 * Extract task IDs from a relationship value.
 *
 * Only the leading list is considered, so explanatory prose in parentheses
 * (for example `T03 (но оба меняют internal/worker)`) cannot introduce
 * accidental dependencies.
 */
export function parseTaskIds(value: string | null): string[] {
	if (!value) {
		return []
	}

	const head = value.split(/[（(]/, 1)[0] ?? value
	const ids = Array.from(head.matchAll(TASK_ID_PATTERN), (match) => match[0])
	return [...new Set(ids)]
}

function normalizeStatus(value: string | null): { status: ImplementationTaskStatus | null; problem: string | null } {
	if (!value) {
		return { status: null, problem: "missing Status" }
	}

	const normalized = value.trim().toUpperCase()
	// Legacy artifacts use PENDING for an implementation unit that has not started.
	const candidate = normalized === "PENDING" ? "TODO" : normalized

	if (!isImplementationTaskStatus(candidate)) {
		return { status: null, problem: `invalid Status: ${value.trim()}` }
	}

	return { status: candidate, problem: null }
}

/**
 * Parse a single implementation unit artifact. Pure and filesystem-free.
 */
export function parseImplementationTask(fileName: string, artifact: string, content: string): ImplementationTask {
	const frontmatter = parseFrontmatter(content)
	const statusSection = readSection(content, "Status")
	const relationships = readSection(content, "Relationships")

	const declaredStatus = frontmatter?.values.get("status") ?? readField(statusSection, "Status")
	const { status, problem } = normalizeStatus(declaredStatus)

	const frontmatterDependencies = frontmatter?.lists.get("depends_on")
	const dependsOn = frontmatterDependencies
		? frontmatterDependencies.flatMap((entry) => parseTaskIds(entry))
		: parseTaskIds(readField(relationships, "Depends on"))

	const frontmatterParallel = frontmatter?.lists.get("parallel_with")
	const parallelWith = frontmatterParallel
		? frontmatterParallel.flatMap((entry) => parseTaskIds(entry))
		: parseTaskIds(readField(relationships, "Parallel with"))

	return {
		id: TASK_FILE_NAME_PATTERN.exec(fileName)?.[1] ?? fileName,
		fileName,
		artifact,
		status,
		statusProblem: problem,
		dependsOn: [...new Set(dependsOn)],
		parallelWith: [...new Set(parallelWith)],
		produces: readField(relationships, "Produces"),
		consumes: readField(relationships, "Consumes"),
		unclosedCodeFence: hasUnclosedCodeFence(content),
	}
}

/**
 * Deterministic task order: T02 before T10.
 */
export function sortTasks(tasks: readonly ImplementationTask[]): ImplementationTask[] {
	return [...tasks].sort((left, right) => left.id.localeCompare(right.id, "en", { numeric: true }))
}

/**
 * Tasks that can start now: `Status: TODO` with every `Depends on` entry `DONE`.
 *
 * A dependency that does not exist is never `DONE`, so a dangling reference
 * keeps the dependent task blocked instead of silently unblocking it.
 */
export function readyTasks(tasks: readonly ImplementationTask[]): ImplementationTask[] {
	const done = new Set(tasks.filter((task) => task.status === "DONE").map((task) => task.id))

	return sortTasks(tasks).filter(
		(task) => task.status === "TODO" && task.dependsOn.every((dependency) => done.has(dependency)),
	)
}

/**
 * Find dependency cycles. Each cycle is returned as a closed path, e.g.
 * `["T01", "T02", "T01"]`. Self-dependencies produce `["T01", "T01"]`.
 */
export function findDependencyCycles(tasks: readonly ImplementationTask[]): string[][] {
	const byId = new Map(tasks.map((task) => [task.id, task]))
	const state = new Map<string, "visiting" | "visited">()
	const cycles: string[][] = []
	const stack: string[] = []

	const visit = (id: string): void => {
		const current = state.get(id)
		if (current === "visited") {
			return
		}
		if (current === "visiting") {
			const start = stack.indexOf(id)
			cycles.push([...stack.slice(start), id])
			return
		}

		state.set(id, "visiting")
		stack.push(id)

		for (const dependency of byId.get(id)?.dependsOn ?? []) {
			if (byId.has(dependency)) {
				visit(dependency)
			}
		}

		stack.pop()
		state.set(id, "visited")
	}

	for (const task of sortTasks(tasks)) {
		visit(task.id)
	}

	return cycles
}

export class TxxParser {
	constructor(private readonly fileSystem: ImplementationFileSystem = fs) {}

	async read(context: TaskContext): Promise<ImplementationArtifacts> {
		const directory = path.join(context.taskRoot, IMPLEMENTATION_DIRECTORY)

		let entries: string[]
		try {
			entries = await this.fileSystem.readdir(directory)
		} catch (error) {
			if (isFileNotFound(error)) {
				return { directory, missingDirectory: true, tasks: [], duplicateIds: [], unexpectedFiles: [] }
			}
			throw error
		}

		const taskFiles = entries.filter((entry) => TASK_FILE_NAME_PATTERN.test(entry)).sort()
		const unexpectedFiles = entries
			.filter((entry) => entry.endsWith(".md") && !TASK_FILE_NAME_PATTERN.test(entry))
			.sort()

		const tasks: ImplementationTask[] = []
		for (const fileName of taskFiles) {
			const artifact = path.join(directory, fileName)
			const content = await this.fileSystem.readFile(artifact, "utf8")
			tasks.push(parseImplementationTask(fileName, artifact, content))
		}

		const counts = new Map<string, number>()
		for (const task of tasks) {
			counts.set(task.id, (counts.get(task.id) ?? 0) + 1)
		}

		const duplicateIds = [...counts.entries()]
			.filter(([, count]) => count > 1)
			.map(([id]) => id)
			.sort()

		return { directory, missingDirectory: false, tasks, duplicateIds, unexpectedFiles }
	}
}
