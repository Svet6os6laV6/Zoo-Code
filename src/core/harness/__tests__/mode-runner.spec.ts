import * as path from "path"

import {
	LifecycleController,
	ModeRunner,
	TaskScheduler,
	TaskStateResolver,
	type LifecycleResult,
	type ModeRunResult,
	type TaskContext,
	type TaskState,
} from "@roo-code/core"

import { HarnessModeRunner } from "../mode-runner"

const context: TaskContext = {
	taskId: "SITESUP-1116",
	branch: "feature/SITESUP-1116",
	taskRoot: "/workspace/.roo/tasks/SITESUP-1116",
}
const state: TaskState = {
	taskId: context.taskId,
	status: "REVIEW",
	currentTask: null,
	currentTaskArtifact: null,
}

describe("HarnessModeRunner", () => {
	it("turns a reviewer semantic result into an executed QA decision", async () => {
		const expectedDecision: LifecycleResult = {
			type: "start_mode",
			status: "REVIEW_PASSED",
			mode: "qa",
		}
		const expectedResult: ModeRunResult = {
			type: "started",
			status: "REVIEW_PASSED",
			mode: "qa",
		}
		const transition = vi.fn().mockReturnValue(expectedDecision)
		const run = vi.fn().mockResolvedValue(expectedResult)
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve: vi.fn().mockResolvedValue(state) },
			controller: { transition },
			modeRunner: { run },
		})

		const result = await runner.run(
			{ getTaskContext: vi.fn().mockResolvedValue(context) },
			"reviewer",
			"Review complete.\nStage Result: PASSED\nNext Mode: code",
		)

		expect(transition).toHaveBeenCalledWith(state, { mode: "reviewer", result: "PASSED" })
		expect(run).toHaveBeenCalledWith(context, state, expectedDecision)
		expect(result).toEqual(expectedResult)
	})

	it("leaves ordinary subtasks on the existing parent-resume path", async () => {
		const resolve = vi.fn()
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve },
			controller: { transition: vi.fn() },
			modeRunner: { run: vi.fn() },
		})

		const result = await runner.run(
			{ getTaskContext: vi.fn().mockResolvedValue(context) },
			"debug",
			"Investigation complete.",
		)

		expect(result).toBeNull()
		expect(resolve).not.toHaveBeenCalled()
	})

	it("falls back to the parent when scheduling cannot produce a next stage", async () => {
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve: vi.fn().mockResolvedValue({ ...state, status: "IMPLEMENTATION" }) },
			controller: {
				transition: vi.fn().mockReturnValue({
					type: "schedule_implementation",
					status: "READY_FOR_IMPLEMENTATION",
				}),
			},
			modeRunner: { run: vi.fn().mockResolvedValue({ type: "invalid", reason: "No ready task" }) },
		})

		const result = await runner.run(
			{ getTaskContext: vi.fn().mockResolvedValue(context) },
			"code",
			"Stage Result: COMPLETED",
		)

		expect(result).toBeNull()
	})

	it("routes a completed fix pass through the real lifecycle instead of the parent fallback", async () => {
		const taskRoot = path.join("/workspace", ".roo", "tasks", "SITESUP-1116")
		const readmePath = path.join(taskRoot, "README.md")
		const files = new Map<string, string>([
			[readmePath, "Protocol Version: 2\nTask: SITESUP-1116\nStatus: REVIEW\nCurrent Task: NONE\n"],
		])
		const fileSystem = {
			readFile: async (filePath: string) => {
				const content = files.get(filePath)
				if (content === undefined) throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" })
				return content
			},
			readdir: async (dirPath: string) => {
				const prefix = `${dirPath}${path.sep}`
				const entries = [...files.keys()]
					.filter((filePath) => filePath.startsWith(prefix))
					.map((filePath) => filePath.slice(prefix.length))
				if (entries.length === 0) throw Object.assign(new Error(`ENOENT: ${dirPath}`), { code: "ENOENT" })
				return entries
			},
			writeFile: async (filePath: string, data: string) => {
				files.set(filePath, data)
			},
			rename: async (oldPath: string, newPath: string) => {
				const content = files.get(oldPath)
				if (content === undefined) throw Object.assign(new Error(`ENOENT: ${oldPath}`), { code: "ENOENT" })
				files.delete(oldPath)
				files.set(newPath, content)
			},
		}
		const fixContext: TaskContext = { ...context, taskRoot }
		const starts: Array<{ mode: string; message: string }> = []
		const runner = new HarnessModeRunner(
			async (mode, message) => {
				starts.push({ mode, message })
			},
			{
				stateResolver: new TaskStateResolver(fileSystem),
				controller: new LifecycleController(),
				modeRunner: new ModeRunner(
					async (mode, message) => {
						starts.push({ mode, message })
					},
					new TaskScheduler(fileSystem),
					fileSystem,
				),
			},
		)

		const result = await runner.run(
			{ getTaskContext: vi.fn().mockResolvedValue(fixContext) },
			"code",
			"Fixed the reported defect.\nStage Result: COMPLETED",
		)

		expect(result).toEqual({ type: "started", mode: "reviewer", status: "READY_FOR_REVIEW" })
		expect(starts.map((start) => start.mode)).toEqual(["reviewer"])
		expect(files.get(readmePath)).toContain("Status: READY_FOR_REVIEW")
	})
})
