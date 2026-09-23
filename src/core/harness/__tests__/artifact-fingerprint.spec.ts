// npx vitest core/harness/__tests__/artifact-fingerprint.spec.ts

import type { ImplementationArtifacts, ImplementationTask } from "@roo-code/core"

import { computeArtifactFingerprint } from "../artifact-fingerprint"

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
