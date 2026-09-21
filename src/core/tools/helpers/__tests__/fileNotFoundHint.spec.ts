import type { Dirent } from "fs"

import { describe, it, expect, vi, beforeEach } from "vitest"

import { buildFileNotFoundHint, isNotFoundError, levenshteinDistance, similarityScore } from "../fileNotFoundHint"

// `fs/promises.readdir` is overloaded (string[] vs Dirent[]); a hoisted untyped
// mock keeps `mockResolvedValue` accepting `Dirent[]` without casts.
const mocks = vi.hoisted(() => ({
	readdir: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	readdir: mocks.readdir,
}))

const mockedReaddir = mocks.readdir

function dirent(name: string, isDirectory = false): Dirent {
	return {
		name,
		parentPath: "",
		path: "",
		isFile: () => !isDirectory,
		isDirectory: () => isDirectory,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false,
		isSymbolicLink: () => false,
	}
}

function enoent(): NodeJS.ErrnoException {
	return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
}

describe("fileNotFoundHint", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("isNotFoundError", () => {
		it("detects ENOENT via error code", () => {
			expect(isNotFoundError(enoent())).toBe(true)
		})

		it("detects ENOENT via message", () => {
			expect(isNotFoundError(new Error("ENOENT: no such file or directory"))).toBe(true)
		})

		it("returns false for unrelated errors", () => {
			expect(isNotFoundError(new Error("Permission denied"))).toBe(false)
			expect(isNotFoundError(undefined)).toBe(false)
			expect(isNotFoundError("ENOENT")).toBe(false)
		})
	})

	describe("levenshteinDistance", () => {
		it("returns 0 for identical strings", () => {
			expect(levenshteinDistance("abc", "abc")).toBe(0)
		})

		it("computes edit distance", () => {
			expect(levenshteinDistance("kitten", "sitting")).toBe(3)
		})

		it("handles empty strings", () => {
			expect(levenshteinDistance("", "abc")).toBe(3)
			expect(levenshteinDistance("abc", "")).toBe(3)
		})
	})

	describe("similarityScore", () => {
		it("returns 1 for identical strings (case-insensitive)", () => {
			expect(similarityScore("File.TS", "file.ts")).toBe(1)
		})

		it("returns a high score for near matches", () => {
			expect(similarityScore("T03-max-bot-api-client.md", "T03-max-client-config.md")).toBeGreaterThan(0.5)
		})

		it("returns a low score for unrelated names", () => {
			expect(similarityScore("alpha.ts", "zzzzzzzz.ts")).toBeLessThan(0.3)
		})
	})

	describe("buildFileNotFoundHint", () => {
		it("returns empty string for non-ENOENT errors", async () => {
			const hint = await buildFileNotFoundHint(
				"src/missing.ts",
				"/ws/src/missing.ts",
				"/ws",
				new Error("Permission denied"),
			)
			expect(hint).toBe("")
			expect(mockedReaddir).not.toHaveBeenCalled()
		})

		it("suggests the closest matching sibling file", async () => {
			mockedReaddir.mockResolvedValue([
				dirent("T03-max-client-config.md"),
				dirent("T04-max-bot-wiring.md"),
				dirent("unrelated.txt"),
			])

			const hint = await buildFileNotFoundHint(
				".roo/tasks/SITESUP-1119/implementation/T03-max-bot-api-client.md",
				"/ws/.roo/tasks/SITESUP-1119/implementation/T03-max-bot-api-client.md",
				"/ws",
				enoent(),
			)

			expect(hint).toContain("was not found")
			expect(hint).toContain("T03-max-client-config.md")
			expect(hint).toContain(".roo/tasks/SITESUP-1119/implementation")
			// The unrelated entry should be filtered out by the score threshold.
			expect(hint).not.toContain("unrelated.txt")
		})

		it("marks directories with a trailing slash", async () => {
			mockedReaddir.mockResolvedValue([dirent("max", true), dirent("telegram", true)])

			const hint = await buildFileNotFoundHint(
				"internal/notification/maxx",
				"/ws/internal/notification/maxx",
				"/ws",
				enoent(),
			)

			expect(hint).toContain("max/")
		})

		it("walks up to the nearest existing ancestor when the parent is missing", async () => {
			// First readdir (the missing parent) rejects, second (ancestor) succeeds.
			mockedReaddir
				.mockRejectedValueOnce(enoent())
				.mockResolvedValueOnce([dirent("implementation", true), dirent("handoff.md")])

			const hint = await buildFileNotFoundHint(
				".roo/tasks/SITESUP-1119/implementation/T03.md",
				"/ws/.roo/tasks/SITESUP-1119/implementation/T03.md",
				"/ws",
				enoent(),
			)

			expect(hint).toContain("implementation/")
			expect(hint).toContain(".roo/tasks/SITESUP-1119")
		})

		it("reports when the directory exists but has no similar entries", async () => {
			mockedReaddir.mockResolvedValue([dirent("alpha.ts"), dirent("beta.ts")])

			const hint = await buildFileNotFoundHint("src/zzzzzzzzzzzz.ts", "/ws/src/zzzzzzzzzzzz.ts", "/ws", enoent())

			expect(hint).toContain("no similar entries")
			expect(hint).toContain("list_files")
		})

		it("returns empty string when no directory can be found", async () => {
			mockedReaddir.mockRejectedValue(enoent())

			const hint = await buildFileNotFoundHint("missing.ts", "/ws/missing.ts", "/ws", enoent())

			expect(hint).toBe("")
		})

		it("respects maxSuggestions", async () => {
			mockedReaddir.mockResolvedValue([dirent("file-a.ts"), dirent("file-b.ts"), dirent("file-c.ts")])

			const hint = await buildFileNotFoundHint("src/file-x.ts", "/ws/src/file-x.ts", "/ws", enoent(), {
				maxSuggestions: 1,
			})

			const bulletCount = (hint.match(/^- /gm) || []).length
			expect(bulletCount).toBe(1)
		})
	})
})
