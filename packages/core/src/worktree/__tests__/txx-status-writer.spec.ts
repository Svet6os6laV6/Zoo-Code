import * as path from "path"

import { parkImplementationTask } from "../txx-status-writer.js"
import { createInMemoryFileSystem } from "./helpers/in-memory-fs.js"

const artifact = path.join("/workspace", ".roo", "tasks", "SITESUP-1119", "implementation", "T02-unit.md")

describe("parkImplementationTask", () => {
	it("parks an IN_PROGRESS unit in the protocol v2 Status section", async () => {
		const content = "## Status\nStatus: IN_PROGRESS\n\n## Relationships\n\n- Depends on: T03\n"
		const fileSystem = createInMemoryFileSystem({ [artifact]: content })

		const result = await parkImplementationTask(fileSystem, artifact)

		expect(result.type).toBe("parked")
		expect(fileSystem.files.get(artifact)).toBe(
			"## Status\nStatus: TODO\n\n## Relationships\n\n- Depends on: T03\n",
		)
	})

	it("parks an IN_PROGRESS unit declared in YAML frontmatter", async () => {
		const content = "---\nstatus: IN_PROGRESS\ndepends_on:\n  - T03\n---\n\n# T02\n"
		const fileSystem = createInMemoryFileSystem({ [artifact]: content })

		const result = await parkImplementationTask(fileSystem, artifact)

		expect(result.type).toBe("parked")
		expect(fileSystem.files.get(artifact)).toBe("---\nstatus: TODO\ndepends_on:\n  - T03\n---\n\n# T02\n")
	})

	it("leaves a DONE unit untouched", async () => {
		const content = "## Status\nStatus: DONE\n"
		const fileSystem = createInMemoryFileSystem({ [artifact]: content })

		const result = await parkImplementationTask(fileSystem, artifact)

		expect(result).toEqual({ type: "unchanged", filePath: artifact, status: "DONE", reason: "not-in-progress" })
		expect(fileSystem.files.get(artifact)).toBe(content)
	})

	it("leaves a TODO unit untouched", async () => {
		const content = "## Status\nStatus: TODO\n"
		const fileSystem = createInMemoryFileSystem({ [artifact]: content })

		const result = await parkImplementationTask(fileSystem, artifact)

		expect(result).toEqual({ type: "unchanged", filePath: artifact, status: "TODO", reason: "not-in-progress" })
		expect(fileSystem.files.get(artifact)).toBe(content)
	})

	it("reports no-status-field when the artifact declares no status", async () => {
		const content = "# T02\n\nNo status here.\n"
		const fileSystem = createInMemoryFileSystem({ [artifact]: content })

		const result = await parkImplementationTask(fileSystem, artifact)

		expect(result).toEqual({ type: "unchanged", filePath: artifact, status: null, reason: "no-status-field" })
		expect(fileSystem.files.get(artifact)).toBe(content)
	})

	it("writes atomically, leaving no temporary file behind", async () => {
		const fileSystem = createInMemoryFileSystem({ [artifact]: "## Status\nStatus: IN_PROGRESS\n" })

		await parkImplementationTask(fileSystem, artifact)

		expect([...fileSystem.files.keys()].some((filePath) => filePath.endsWith(".tmp"))).toBe(false)
	})
})
