import * as path from "path"

import type { HarnessLoggerPort } from "../../observability/types.js"
import { TaskResolutionError, TaskResolver } from "../task-resolver.js"

const workspacePath = path.join("/tmp", "workspace with spaces")

type MkdirCall = {
	dirPath: string
	options: { recursive: true }
}

type FakeFileSystem = {
	mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>
	readonly mkdirCalls: MkdirCall[]
}

function fakeFileSystem(options: { error?: Error } = {}): FakeFileSystem {
	const mkdirCalls: MkdirCall[] = []
	return {
		mkdirCalls,
		mkdir: async (dirPath, mkdirOptions) => {
			if (options.error) {
				throw options.error
			}
			mkdirCalls.push({ dirPath, options: mkdirOptions })
			return undefined
		},
	}
}

function resolverFor(
	branch: string | null,
	options: {
		pattern?: RegExp
		fileSystem?: FakeFileSystem
		logger?: HarnessLoggerPort
	} = {},
): TaskResolver {
	return new TaskResolver(
		{ getCurrentBranch: async () => branch },
		options.pattern,
		options.logger,
		options.fileSystem ?? fakeFileSystem(),
	)
}

/**
 * Resolves `branch` with a fake file system and asserts the resulting task
 * context plus the single `mkdir` call that guarantees the task root.
 */
async function expectResolvesTo(branch: string, expectedTaskId: string): Promise<void> {
	const fileSystem = fakeFileSystem()
	const resolution = await resolverFor(branch, { fileSystem }).resolve({ workspacePath })
	const expectedTaskRoot = path.join(workspacePath, ".roo", "tasks", expectedTaskId)

	expect(resolution).toEqual({ taskId: expectedTaskId, branch, taskRoot: expectedTaskRoot })
	expect(fileSystem.mkdirCalls).toEqual([{ dirPath: expectedTaskRoot, options: { recursive: true } }])
}

describe("TaskResolver", () => {
	it.each([
		["SITESUP-1116", "SITESUP-1116"],
		["feature/SITESUP-1116-heartbeat", "SITESUP-1116"],
		["fix/SITESUP-42", "SITESUP-42"],
		["user/foo/SITESUP-1116-test", "SITESUP-1116"],
		["feature/PAYMENT-421-retry", "PAYMENT-421"],
		["feature/PROJECT1-99-retry", "PROJECT1-99"],
	])("resolves %s to %s", async (branch, expectedTaskId) => {
		await expectResolvesTo(branch, expectedTaskId)
	})

	it.each([
		["webhook-mvp", "webhook-mvp"],
		["feature/foo", "feature-foo"],
		["feature/webhook-mvp", "feature-webhook-mvp"],
		["main", "main"],
		["develop", "develop"],
		["release/1.2.3", "release-1.2.3"],
	])("falls back to the sanitized branch name %s -> %s", async (branch, expectedTaskId) => {
		await expectResolvesTo(branch, expectedTaskId)
	})

	it("collapses run-together dots so the task ID never contains '..'", async () => {
		await expectResolvesTo("feature/foo..bar", "feature-foo.bar")
	})

	it("trims leading and trailing separators from the fallback task ID", async () => {
		await expectResolvesTo("-feature/foo-", "feature-foo")
	})

	it("rejects a branch whose sanitized name is empty", async () => {
		await expect(resolverFor("ветка").resolve({ workspacePath })).rejects.toEqual(
			new TaskResolutionError(
				"Unable to resolve task ID from current Git branch: sanitized branch name is empty",
			),
		)
	})

	it("rejects a branch with different task IDs", async () => {
		await expect(resolverFor("feature/SITESUP-1116-PAYMENT-421").resolve({ workspacePath })).rejects.toEqual(
			new TaskResolutionError("Multiple task IDs found in current Git branch: SITESUP-1116, PAYMENT-421"),
		)
	})

	it("accepts repeated occurrences of the same task ID", async () => {
		await expectResolvesTo("SITESUP-1116/merge-SITESUP-1116", "SITESUP-1116")
	})

	it("supports a configured task ID pattern", async () => {
		const resolution = await resolverFor("feature/site-42", { pattern: /site-\d+/i }).resolve({ workspacePath })

		expect(resolution.taskId).toBe("site-42")
	})

	it("falls back to the sanitized branch name when a configured pattern has no matches", async () => {
		const resolution = await resolverFor("feature/site-42", { pattern: /SITESUP-\d+/ }).resolve({ workspacePath })

		expect(resolution.taskId).toBe("feature-site-42")
	})

	it("rejects detached HEAD", async () => {
		await expect(resolverFor(null).resolve({ workspacePath })).rejects.toEqual(
			new TaskResolutionError("Unable to resolve task ID from current Git branch"),
		)
	})

	it("rejects when the task root directory cannot be created", async () => {
		const fileSystem = fakeFileSystem({
			error: Object.assign(new Error("EEXIST: .roo/tasks is not a directory"), { code: "EEXIST" }),
		})

		await expect(resolverFor("SITESUP-1116", { fileSystem }).resolve({ workspacePath })).rejects.toEqual(
			new TaskResolutionError(
				`Unable to create task root directory ${path.join(workspacePath, ".roo", "tasks", "SITESUP-1116")}: EEXIST: .roo/tasks is not a directory`,
			),
		)
	})
})
