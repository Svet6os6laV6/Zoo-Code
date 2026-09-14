import * as path from "path"

import type { TaskContext } from "../task-resolver.js"
import { createInMemoryFileSystem } from "./helpers/in-memory-fs.js"
import {
	findDependencyCycles,
	parseImplementationTask,
	parseTaskIds,
	readyTasks,
	sortTasks,
	TxxParser,
	type ImplementationTask,
} from "../txx-parser.js"

const taskContext: TaskContext = {
	taskId: "SITESUP-1116",
	branch: "feature/SITESUP-1116-heartbeat",
	taskRoot: path.join("/workspace", ".roo", "tasks", "SITESUP-1116"),
}

function task(id: string, status: ImplementationTask["status"], dependsOn: string[] = []): ImplementationTask {
	return {
		id,
		fileName: `${id}-unit.md`,
		artifact: path.join(taskContext.taskRoot, "implementation", `${id}-unit.md`),
		status,
		statusProblem: null,
		dependsOn,
		parallelWith: [],
		produces: null,
		consumes: null,
		unclosedCodeFence: false,
	}
}

function parserFor(files: Record<string, string>): TxxParser {
	return new TxxParser(createInMemoryFileSystem(files))
}

describe("parseImplementationTask", () => {
	it("parses protocol v2 sections", () => {
		const parsed = parseImplementationTask(
			"T02-worker-manual-run.md",
			"/workspace/.roo/tasks/SITESUP-1116/implementation/T02-worker-manual-run.md",
			`# T02 — Worker

## Status
Status: DONE

## Relationships

- Depends on: T01 (колонка run_requested_at, ClearRunRequest).
- Parallel with: T03 (но оба меняют internal/worker).
- Produces: воркер исполняет запрос в пределах refresh-интервала.
- Consumes: contract T01 Produces.
`,
		)

		expect(parsed).toMatchObject({
			id: "T02",
			fileName: "T02-worker-manual-run.md",
			status: "DONE",
			statusProblem: null,
			dependsOn: ["T01"],
			parallelWith: ["T03"],
			produces: "воркер исполняет запрос в пределах refresh-интервала.",
			consumes: "contract T01 Produces.",
			unclosedCodeFence: false,
		})
	})

	it("parses YAML frontmatter", () => {
		const parsed = parseImplementationTask(
			"T03-stale-reconciler.md",
			"/workspace/.roo/tasks/SITESUP-1116/implementation/T03-stale-reconciler.md",
			`---
id: T03
status: TODO
depends_on:
  - T01
  - T02
parallel_with:
  - T04
---

# T03
`,
		)

		expect(parsed).toMatchObject({
			id: "T03",
			status: "TODO",
			dependsOn: ["T01", "T02"],
			parallelWith: ["T04"],
		})
	})

	it("maps the legacy PENDING status to TODO", () => {
		const parsed = parseImplementationTask("T01-unit.md", "/tmp/T01-unit.md", "## Status\nStatus: PENDING\n")

		expect(parsed.status).toBe("TODO")
		expect(parsed.statusProblem).toBeNull()
	})

	it("reports a missing status instead of throwing", () => {
		const parsed = parseImplementationTask("T01-unit.md", "/tmp/T01-unit.md", "# T01\n\n## Goal\n\nDo it.\n")

		expect(parsed.status).toBeNull()
		expect(parsed.statusProblem).toBe("missing Status")
	})

	it("reports an invalid status instead of throwing", () => {
		const parsed = parseImplementationTask("T01-unit.md", "/tmp/T01-unit.md", "## Status\nStatus: STARTED\n")

		expect(parsed.status).toBeNull()
		expect(parsed.statusProblem).toBe("invalid Status: STARTED")
	})

	it("flags a truncated artifact with an unclosed code fence", () => {
		const parsed = parseImplementationTask(
			"T01-unit.md",
			"/tmp/T01-unit.md",
			"## Status\nStatus: TODO\n\n```go\nfunc main() {}\n",
		)

		expect(parsed.unclosedCodeFence).toBe(true)
	})

	it("ignores explanatory prose when reading dependencies", () => {
		expect(parseTaskIds("T01 (колонка run_requested_at, ClearRunRequest)")).toEqual(["T01"])
		expect(parseTaskIds("T01, T02")).toEqual(["T01", "T02"])
		expect(parseTaskIds("NONE")).toEqual([])
		expect(parseTaskIds(null)).toEqual([])
	})
})

describe("DAG helpers", () => {
	const dag = [
		task("T01", "DONE"),
		task("T02", "TODO", ["T01"]),
		task("T03", "TODO", ["T01"]),
		task("T04", "TODO", ["T02", "T03"]),
	]

	it("returns every ready task in deterministic order", () => {
		expect(readyTasks(dag).map((item) => item.id)).toEqual(["T02", "T03"])
	})

	it("keeps a task blocked while a dependency is unfinished", () => {
		const tasks = [task("T01", "IN_PROGRESS"), task("T02", "TODO", ["T01"])]

		expect(readyTasks(tasks)).toEqual([])
	})

	it("keeps a task blocked when a dependency does not exist", () => {
		const tasks = [task("T03", "TODO", ["T99"])]

		expect(readyTasks(tasks)).toEqual([])
	})

	it("sorts task IDs numerically", () => {
		expect(sortTasks([task("T10", "TODO"), task("T02", "TODO")]).map((item) => item.id)).toEqual(["T02", "T10"])
	})

	it("detects a dependency cycle", () => {
		const tasks = [task("T01", "TODO", ["T02"]), task("T02", "TODO", ["T01"])]

		expect(findDependencyCycles(tasks)).toEqual([["T01", "T02", "T01"]])
	})

	it("detects a self-dependency", () => {
		expect(findDependencyCycles([task("T01", "TODO", ["T01"])])).toEqual([["T01", "T01"]])
	})

	it("reports no cycle for an acyclic DAG", () => {
		expect(findDependencyCycles(dag)).toEqual([])
	})
})

describe("TxxParser", () => {
	it("reads implementation artifacts and reports duplicates and unexpected files", async () => {
		const directory = path.join(taskContext.taskRoot, "implementation")
		const artifacts = await parserFor({
			[path.join(directory, "T01-trigger.md")]: "## Status\nStatus: DONE\n",
			[path.join(directory, "T01-duplicate.md")]: "## Status\nStatus: TODO\n",
			[path.join(directory, "T02-worker.md")]:
				"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T01\n",
			[path.join(directory, "notes.md")]: "# Notes\n",
		}).read(taskContext)

		expect(artifacts.missingDirectory).toBe(false)
		expect(artifacts.tasks.map((item) => item.id)).toEqual(["T01", "T01", "T02"])
		expect(artifacts.duplicateIds).toEqual(["T01"])
		expect(artifacts.unexpectedFiles).toEqual(["notes.md"])
	})

	it("reports a missing implementation directory", async () => {
		const artifacts = await parserFor({}).read(taskContext)

		expect(artifacts.missingDirectory).toBe(true)
		expect(artifacts.tasks).toEqual([])
	})
})
