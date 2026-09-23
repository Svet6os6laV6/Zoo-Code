// npx vitest core/harness/__tests__/artifact-fingerprint.spec.ts

import type { ImplementationArtifacts, ImplementationTask } from "@roo-code/core"

import {
	computeArtifactFingerprint,
	computeArtifactStatFingerprint,
	type ArtifactStatEntry,
	type ArtifactStatFingerprintInput,
} from "../artifact-fingerprint"

function unit(id: string, contentHash: string, fileName = `${id}-unit.md`): ImplementationTask {
	return {
		id,
		fileName,
		artifact: `/task/implementation/${fileName}`,
		status: "TODO",
		statusProblem: null,
		dependsOn: [],
		parallelWith: [],
		produces: null,
		consumes: null,
		unclosedCodeFence: false,
		contentHash,
	}
}

function snapshot(overrides: Partial<ImplementationArtifacts> = {}): ImplementationArtifacts {
	return {
		directory: "/task/implementation",
		missingDirectory: false,
		tasks: [],
		duplicateIds: [],
		unexpectedFiles: [],
		...overrides,
	}
}

describe("computeArtifactFingerprint", () => {
	it("returns the same fingerprint for identical README and snapshot", () => {
		const readme = "# Task\n\nStatus: IMPLEMENTATION\n"
		const artifacts = snapshot({ tasks: [unit("T01", "hash-a"), unit("T02", "hash-b")] })

		expect(computeArtifactFingerprint({ readme, snapshot: artifacts })).toBe(
			computeArtifactFingerprint({ readme, snapshot: artifacts }),
		)
	})

	it("is independent of the readdir order of the implementation units", () => {
		const readme = "# Task\n"
		const first = snapshot({ tasks: [unit("T01", "hash-a"), unit("T02", "hash-b")] })
		const second = snapshot({ tasks: [unit("T02", "hash-b"), unit("T01", "hash-a")] })

		expect(computeArtifactFingerprint({ readme, snapshot: first })).toBe(
			computeArtifactFingerprint({ readme, snapshot: second }),
		)
	})

	it("changes when a unit status move rewrites the artifact content", () => {
		const readme = "# Task\n"
		const before = snapshot({ tasks: [unit("T01", "hash-in-progress")] })
		const after = snapshot({ tasks: [unit("T01", "hash-done")] })

		expect(computeArtifactFingerprint({ readme, snapshot: before })).not.toBe(
			computeArtifactFingerprint({ readme, snapshot: after }),
		)
	})

	it("changes when the canonical README is rewritten", () => {
		const artifacts = snapshot({ tasks: [unit("T01", "hash-a")] })

		expect(computeArtifactFingerprint({ readme: "Status: IMPLEMENTATION\n", snapshot: artifacts })).not.toBe(
			computeArtifactFingerprint({ readme: "Status: READY_FOR_REVIEW\n", snapshot: artifacts }),
		)
	})

	it("changes when a unit is added or removed", () => {
		const readme = "# Task\n"
		const one = snapshot({ tasks: [unit("T01", "hash-a")] })
		const two = snapshot({ tasks: [unit("T01", "hash-a"), unit("T02", "hash-b")] })

		expect(computeArtifactFingerprint({ readme, snapshot: one })).not.toBe(
			computeArtifactFingerprint({ readme, snapshot: two }),
		)
	})

	it("changes when a unit is renamed without changing its content", () => {
		const readme = "# Task\n"
		const before = snapshot({ tasks: [unit("T01", "hash-a", "T01-old.md")] })
		const after = snapshot({ tasks: [unit("T01", "hash-a", "T01-new.md")] })

		expect(computeArtifactFingerprint({ readme, snapshot: before })).not.toBe(
			computeArtifactFingerprint({ readme, snapshot: after }),
		)
	})

	it("changes when directory-level validation inputs change", () => {
		const readme = "# Task\n"
		const clean = snapshot({ tasks: [unit("T01", "hash-a")] })
		const withUnexpectedFile = snapshot({ tasks: [unit("T01", "hash-a")], unexpectedFiles: ["notes.md"] })

		expect(computeArtifactFingerprint({ readme, snapshot: clean })).not.toBe(
			computeArtifactFingerprint({ readme, snapshot: withUnexpectedFile }),
		)
	})

	it("treats a missing README as a stable value", () => {
		const artifacts = snapshot({ tasks: [unit("T01", "hash-a")] })

		expect(computeArtifactFingerprint({ readme: null, snapshot: artifacts })).toBe(
			computeArtifactFingerprint({ readme: null, snapshot: artifacts }),
		)
		expect(computeArtifactFingerprint({ readme: null, snapshot: artifacts })).not.toBe(
			computeArtifactFingerprint({ readme: "# Task\n", snapshot: artifacts }),
		)
	})
})

function stat(name: string, mtimeMs: number | null, size: number | null): ArtifactStatEntry {
	return { name, mtimeMs, size }
}

function statInput(overrides: Partial<ArtifactStatFingerprintInput> = {}): ArtifactStatFingerprintInput {
	return {
		readme: stat("README.md", 1_000, 200),
		implementation: [stat("T01-unit.md", 1_000, 100)],
		...overrides,
	}
}

describe("computeArtifactStatFingerprint", () => {
	it("returns the same fingerprint for identical metadata", () => {
		const input = statInput()

		expect(computeArtifactStatFingerprint(input)).toBe(computeArtifactStatFingerprint(input))
	})

	it("is independent of the readdir order of the implementation files", () => {
		const first = statInput({
			implementation: [stat("T01-a.md", 1, 10), stat("T02-b.md", 2, 20)],
		})
		const second = statInput({
			implementation: [stat("T02-b.md", 2, 20), stat("T01-a.md", 1, 10)],
		})

		expect(computeArtifactStatFingerprint(first)).toBe(computeArtifactStatFingerprint(second))
	})

	it("changes when a file is renamed", () => {
		const before = statInput({ implementation: [stat("T01-old.md", 1, 10)] })
		const after = statInput({ implementation: [stat("T01-new.md", 1, 10)] })

		expect(computeArtifactStatFingerprint(before)).not.toBe(computeArtifactStatFingerprint(after))
	})

	it("changes when a file is added or removed", () => {
		const one = statInput({ implementation: [stat("T01-a.md", 1, 10)] })
		const two = statInput({ implementation: [stat("T01-a.md", 1, 10), stat("T02-b.md", 2, 20)] })

		expect(computeArtifactStatFingerprint(one)).not.toBe(computeArtifactStatFingerprint(two))
	})

	it("changes when a file size changes at the same mtime", () => {
		const before = statInput({ implementation: [stat("T01-a.md", 1, 10)] })
		const after = statInput({ implementation: [stat("T01-a.md", 1, 11)] })

		expect(computeArtifactStatFingerprint(before)).not.toBe(computeArtifactStatFingerprint(after))
	})

	it("changes when a file mtime changes at the same size", () => {
		const before = statInput({ implementation: [stat("T01-a.md", 1, 10)] })
		const after = statInput({ implementation: [stat("T01-a.md", 2, 10)] })

		expect(computeArtifactStatFingerprint(before)).not.toBe(computeArtifactStatFingerprint(after))
	})

	it("changes when the README metadata changes", () => {
		const before = statInput({ readme: stat("README.md", 1, 200) })
		const after = statInput({ readme: stat("README.md", 2, 200) })

		expect(computeArtifactStatFingerprint(before)).not.toBe(computeArtifactStatFingerprint(after))
	})

	it("treats a readable empty implementation directory as a valid value", () => {
		const empty = statInput({ implementation: [] })

		expect(computeArtifactStatFingerprint(empty)).not.toBeNull()
		expect(computeArtifactStatFingerprint(empty)).toBe(
			computeArtifactStatFingerprint(statInput({ implementation: [] })),
		)
	})

	it("fails safe to null when the README is missing", () => {
		expect(computeArtifactStatFingerprint(statInput({ readme: null }))).toBeNull()
	})

	it("fails safe to null when the implementation directory is unreadable", () => {
		expect(computeArtifactStatFingerprint(statInput({ implementation: null }))).toBeNull()
	})

	it("fails safe to null when a stat field is unavailable", () => {
		expect(computeArtifactStatFingerprint(statInput({ readme: stat("README.md", null, 200) }))).toBeNull()
		expect(computeArtifactStatFingerprint(statInput({ readme: stat("README.md", 1, null) }))).toBeNull()
		expect(computeArtifactStatFingerprint(statInput({ implementation: [stat("T01-a.md", null, 10)] }))).toBeNull()
		expect(computeArtifactStatFingerprint(statInput({ implementation: [stat("T01-a.md", 1, null)] }))).toBeNull()
	})
})
