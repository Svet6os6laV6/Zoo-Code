import * as path from "path"

import {
	LifecycleController,
	ModeRunner,
	TaskScheduler,
	TaskStateResolver,
	type ArtifactValidationReport,
	type ImplementationArtifacts,
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
	failureKey: null,
	failureAttempts: 0,
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
			controller: { transition, resume: vi.fn(), resolve: vi.fn(), approvePlan: vi.fn() },
			modeRunner: { run },
		})

		const result = await runner.run(
			{ getTaskContext: vi.fn().mockResolvedValue(context) },
			"reviewer",
			"Review complete.\nStage Result: PASSED\nNext Mode: code",
		)

		expect(transition).toHaveBeenCalledWith(state, { mode: "reviewer", result: "PASSED", failureKey: null }, {})
		expect(run).toHaveBeenCalledWith(context, state, expectedDecision)
		expect(result).toEqual(expectedResult)
	})

	it("leaves ordinary subtasks on the existing parent-resume path", async () => {
		const resolve = vi.fn()
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve },
			controller: { transition: vi.fn(), resume: vi.fn(), resolve: vi.fn(), approvePlan: vi.fn() },
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
				resume: vi.fn(),
				resolve: vi.fn(),
				approvePlan: vi.fn(),
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

	it("resumes a BLOCKED task through the harness-owned action", async () => {
		const expectedResult: ModeRunResult = { type: "started", status: "IMPLEMENTATION", mode: "code" }
		const blocked = { ...state, status: "BLOCKED" as const }
		const resume = vi.fn().mockReturnValue({ type: "resume_implementation", status: "READY_FOR_IMPLEMENTATION" })
		const run = vi.fn().mockResolvedValue(expectedResult)
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve: vi.fn().mockResolvedValue(blocked) },
			controller: { transition: vi.fn(), resume, resolve: vi.fn(), approvePlan: vi.fn() },
			modeRunner: { run },
		})

		const result = await runner.resume({ getTaskContext: vi.fn().mockResolvedValue(context) }, true)

		expect(resume).toHaveBeenCalledWith(blocked, true)
		expect(result).toEqual(expectedResult)
	})

	it("leaves an unconfirmed resume on the caller's existing path", async () => {
		const blocked = { ...state, status: "BLOCKED" as const }
		const run = vi.fn()
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve: vi.fn().mockResolvedValue(blocked) },
			controller: {
				transition: vi.fn(),
				resume: vi.fn().mockReturnValue({ type: "invalid", reason: "Unblock Condition unconfirmed" }),
				resolve: vi.fn(),
				approvePlan: vi.fn(),
			},
			modeRunner: { run },
		})

		expect(await runner.resume({ getTaskContext: vi.fn().mockResolvedValue(context) }, false)).toBeNull()
		expect(run).not.toHaveBeenCalled()
	})
})

function artifacts(taskCount: number): ImplementationArtifacts {
	return {
		directory: path.join(context.taskRoot, "implementation"),
		missingDirectory: taskCount === 0,
		tasks: Array.from({ length: taskCount }, (_, index) => ({
			id: `T0${index + 1}`,
			fileName: `T0${index + 1}-unit.md`,
			artifact: path.join(context.taskRoot, "implementation", `T0${index + 1}-unit.md`),
			status: "TODO" as const,
			statusProblem: null,
			dependsOn: [],
			parallelWith: [],
			produces: null,
			consumes: null,
			unclosedCodeFence: false,
			contentHash: "hash",
		})),
		duplicateIds: [],
		unexpectedFiles: [],
	}
}

function validationReport(valid: boolean): ArtifactValidationReport {
	const issues = valid
		? []
		: [
				{
					severity: "warning" as const,
					code: "missing-implementation-plan" as const,
					taskId: null,
					message: "Missing implementation-plan.md",
				},
			]
	return { issues, errors: [], warnings: issues, artifacts: artifacts(0), valid }
}

describe("HarnessModeRunner.continue", () => {
	it("advances ANALYSIS with a ready plan to Code when the approval gate is off", async () => {
		const analysisState: TaskState = { ...state, status: "ANALYSIS" }
		const snapshot = artifacts(2)
		const report = validationReport(true)
		const read = vi.fn().mockResolvedValue(snapshot)
		const validate = vi.fn().mockResolvedValue(report)
		const run = vi.fn().mockResolvedValue({ type: "started", mode: "code", status: "IMPLEMENTATION" })
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve: vi.fn().mockResolvedValue(analysisState) },
			controller: new LifecycleController(),
			modeRunner: { run },
			parser: { read },
			validator: { validate },
		})

		const result = await runner.continue(
			{ getTaskContext: vi.fn().mockResolvedValue(context) },
			{ requirePlanApproval: false },
		)

		expect(read).toHaveBeenCalledWith(context)
		expect(validate).toHaveBeenCalledWith(context, { status: "ANALYSIS" }, snapshot)
		expect(run).toHaveBeenCalledWith(context, analysisState, {
			type: "schedule_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})
		expect(result).toEqual({ type: "started", mode: "code", status: "IMPLEMENTATION" })
	})

	it("stops at PLAN_READY when the approval gate is on and starts no mode", async () => {
		const analysisState: TaskState = { ...state, status: "ANALYSIS" }
		const snapshot = artifacts(2)
		const report = validationReport(true)
		const run = vi.fn().mockResolvedValue({ type: "stopped", status: "PLAN_READY", reason: "plan-approval" })
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve: vi.fn().mockResolvedValue(analysisState) },
			controller: new LifecycleController(),
			modeRunner: { run },
			parser: { read: vi.fn().mockResolvedValue(snapshot) },
			validator: { validate: vi.fn().mockResolvedValue(report) },
		})

		const result = await runner.continue(
			{ getTaskContext: vi.fn().mockResolvedValue(context) },
			{ requirePlanApproval: true },
		)

		expect(run).toHaveBeenCalledWith(context, analysisState, {
			type: "stop",
			status: "PLAN_READY",
			reason: "plan-approval",
		})
		expect(result).toEqual({ type: "stopped", status: "PLAN_READY", reason: "plan-approval" })
	})

	it("returns null when the analysis artifacts are not ready", async () => {
		const run = vi.fn()
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve: vi.fn().mockResolvedValue({ ...state, status: "ANALYSIS" }) },
			controller: new LifecycleController(),
			modeRunner: { run },
			parser: { read: vi.fn().mockResolvedValue(artifacts(0)) },
			validator: { validate: vi.fn().mockResolvedValue(validationReport(false)) },
		})

		expect(await runner.continue({ getTaskContext: vi.fn().mockResolvedValue(context) })).toBeNull()
		expect(run).not.toHaveBeenCalled()
	})

	it("returns null for a terminal status", async () => {
		const run = vi.fn()
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve: vi.fn().mockResolvedValue({ ...state, status: "DONE" }) },
			controller: new LifecycleController(),
			modeRunner: { run },
			parser: { read: vi.fn().mockResolvedValue(artifacts(2)) },
			validator: { validate: vi.fn().mockResolvedValue(validationReport(true)) },
		})

		expect(await runner.continue({ getTaskContext: vi.fn().mockResolvedValue(context) })).toBeNull()
		expect(run).not.toHaveBeenCalled()
	})

	it("returns null when the mode runner cannot apply the decision", async () => {
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve: vi.fn().mockResolvedValue({ ...state, status: "IMPLEMENTATION" }) },
			controller: new LifecycleController(),
			modeRunner: { run: vi.fn().mockResolvedValue({ type: "invalid", reason: "No ready task" }) },
			parser: { read: vi.fn().mockResolvedValue(artifacts(2)) },
			validator: { validate: vi.fn().mockResolvedValue(validationReport(true)) },
		})

		expect(await runner.continue({ getTaskContext: vi.fn().mockResolvedValue(context) })).toBeNull()
	})
})

describe("HarnessModeRunner.approvePlan", () => {
	it("approves a PLAN_READY task and starts the first ready unit", async () => {
		const planReady: TaskState = { ...state, status: "PLAN_READY" }
		const expectedResult: ModeRunResult = { type: "started", mode: "code", status: "IMPLEMENTATION" }
		const approvePlan = vi.fn().mockReturnValue({
			type: "resume_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})
		const run = vi.fn().mockResolvedValue(expectedResult)
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve: vi.fn().mockResolvedValue(planReady) },
			controller: { transition: vi.fn(), resume: vi.fn(), resolve: vi.fn(), approvePlan },
			modeRunner: { run },
		})

		const result = await runner.approvePlan({ getTaskContext: vi.fn().mockResolvedValue(context) })

		expect(approvePlan).toHaveBeenCalledWith(planReady)
		expect(run).toHaveBeenCalledWith(context, planReady, {
			type: "resume_implementation",
			status: "READY_FOR_IMPLEMENTATION",
		})
		expect(result).toEqual(expectedResult)
	})

	it("returns null when the task is not at PLAN_READY", async () => {
		const run = vi.fn()
		const runner = new HarnessModeRunner(vi.fn(), {
			stateResolver: { resolve: vi.fn().mockResolvedValue({ ...state, status: "IMPLEMENTATION" }) },
			controller: {
				transition: vi.fn(),
				resume: vi.fn(),
				resolve: vi.fn(),
				approvePlan: vi.fn().mockReturnValue({ type: "invalid", reason: "not PLAN_READY" }),
			},
			modeRunner: { run },
		})

		expect(await runner.approvePlan({ getTaskContext: vi.fn().mockResolvedValue(context) })).toBeNull()
		expect(run).not.toHaveBeenCalled()
	})
})
