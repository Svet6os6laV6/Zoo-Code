import * as path from "path"

import { diffImplementationArtifacts } from "../artifact-diff.js"
import { parseImplementationTask, type ImplementationArtifacts } from "../txx-parser.js"

const implementation = path.join("/workspace", ".roo", "tasks", "SITESUP-1116", "implementation")

function unit(fileName: string, status: string, extra = ""): string {
	return `## Status\nStatus: ${status}\n${extra}`
}

/** Builds a snapshot the same way the real resolver does: by parsing content. */
function snapshot(tasks: Record<string, string>): ImplementationArtifacts {
	return {
		directory: implementation,
		missingDirectory: false,
		tasks: Object.entries(tasks).map(([fileName, content]) =>
			parseImplementationTask(fileName, path.join(implementation, fileName), content),
		),
		duplicateIds: [],
		unexpectedFiles: [],
	}
}

describe("diffImplementationArtifacts", () => {
	it("reports nothing when there is no baseline yet", () => {
		const diff = diffImplementationArtifacts(null, snapshot({ "T01-trigger.md": unit("T01-trigger.md", "TODO") }))

		expect(diff).toEqual({
			rewrittenUnits: [],
			addedUnits: [],
			removedUnits: [],
			statusChanges: [],
			changed: false,
		})
	})

	it("reports nothing when the snapshot is unchanged", () => {
		const tasks = { "T01-trigger.md": unit("T01-trigger.md", "TODO") }
		const diff = diffImplementationArtifacts(snapshot(tasks), snapshot(tasks))

		expect(diff.changed).toBe(false)
		expect(diff.statusChanges).toEqual([])
	})

	it("reports the IN_PROGRESS -> DONE mutation the harness did not perform", () => {
		const before = snapshot({ "T01-trigger.md": unit("T01-trigger.md", "IN_PROGRESS") })
		const after = snapshot({ "T01-trigger.md": unit("T01-trigger.md", "DONE") })

		const diff = diffImplementationArtifacts(before, after)

		expect(diff.statusChanges).toEqual([{ id: "T01", from: "IN_PROGRESS", to: "DONE" }])
		expect(diff.rewrittenUnits).toEqual(["T01"])
		expect(diff.changed).toBe(true)
	})

	it("detects a content rewrite that leaves the parsed status untouched", () => {
		const before = snapshot({ "T01-trigger.md": unit("T01-trigger.md", "TODO", "\n## Notes\nfirst\n") })
		const after = snapshot({ "T01-trigger.md": unit("T01-trigger.md", "TODO", "\n## Notes\nsecond\n") })

		const diff = diffImplementationArtifacts(before, after)

		expect(diff.rewrittenUnits).toEqual(["T01"])
		expect(diff.statusChanges).toEqual([])
		expect(diff.changed).toBe(true)
	})

	it("reports units that appeared and disappeared", () => {
		const before = snapshot({ "T01-trigger.md": unit("T01-trigger.md", "DONE") })
		const after = snapshot({ "T02-worker.md": unit("T02-worker.md", "TODO") })

		const diff = diffImplementationArtifacts(before, after)

		expect(diff.addedUnits).toEqual(["T02"])
		expect(diff.removedUnits).toEqual(["T01"])
		expect(diff.statusChanges).toEqual([{ id: "T02", from: null, to: "TODO" }])
		expect(diff.changed).toBe(true)
	})
})
