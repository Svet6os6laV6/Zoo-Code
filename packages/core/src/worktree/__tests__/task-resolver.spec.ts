import * as path from "path"

import { TaskResolutionError, TaskResolver } from "../task-resolver.js"

const workspacePath = path.join("/tmp", "workspace with spaces")

function resolverFor(branch: string | null, pattern?: RegExp): TaskResolver {
	return new TaskResolver({ getCurrentBranch: async () => branch }, pattern)
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
		const resolution = await resolverFor(branch).resolve({ workspacePath })

		expect(resolution).toEqual({
			taskId: expectedTaskId,
			branch,
			taskRoot: path.join(workspacePath, ".roo", "tasks", expectedTaskId),
		})
	})

	it.each(["main", "develop", "feature/foo"])("rejects unresolved branch %s", async (branch) => {
		await expect(resolverFor(branch).resolve({ workspacePath })).rejects.toEqual(
			new TaskResolutionError("Unable to resolve task ID from current Git branch"),
		)
	})

	it("rejects a branch with different task IDs", async () => {
		await expect(resolverFor("feature/SITESUP-1116-PAYMENT-421").resolve({ workspacePath })).rejects.toEqual(
			new TaskResolutionError("Multiple task IDs found in current Git branch: SITESUP-1116, PAYMENT-421"),
		)
	})

	it("accepts repeated occurrences of the same task ID", async () => {
		const resolution = await resolverFor("SITESUP-1116/merge-SITESUP-1116").resolve({ workspacePath })

		expect(resolution.taskId).toBe("SITESUP-1116")
	})

	it("supports a configured task ID pattern", async () => {
		const resolution = await resolverFor("feature/site-42", /site-\d+/i).resolve({ workspacePath })

		expect(resolution.taskId).toBe("site-42")
	})

	it("rejects detached HEAD", async () => {
		await expect(resolverFor(null).resolve({ workspacePath })).rejects.toEqual(
			new TaskResolutionError("Unable to resolve task ID from current Git branch"),
		)
	})
})
