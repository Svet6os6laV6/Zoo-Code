// npx vitest run core/webview/__tests__/ClineProvider.continue-lifecycle.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { Task } from "../../task/Task"

const continueHarness = vi.hoisted(() => vi.fn())
const runHarness = vi.hoisted(() => vi.fn())
const approveHarness = vi.hoisted(() => vi.fn())
const resolveState = vi.hoisted(() => vi.fn())
const showInformationMessage = vi.hoisted(() => vi.fn())
const showWarningMessage = vi.hoisted(() => vi.fn())
const showErrorMessage = vi.hoisted(() => vi.fn())

vi.mock("vscode", () => {
	const window = {
		showInformationMessage,
		showWarningMessage,
		showErrorMessage,
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const workspace = {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
			update: vi.fn(),
		})),
		workspaceFolders: [],
	}
	const env = { machineId: "test-machine", uriScheme: "vscode", appName: "VSCode", language: "en", sessionId: "s" }
	const Uri = { file: (p: string) => ({ fsPath: p, toString: () => p }) }
	const commands = { executeCommand: vi.fn() }
	const ExtensionMode = { Development: 2 }
	const version = "1.0.0-test"
	return { window, workspace, env, Uri, commands, ExtensionMode, version }
})

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCompleted: vi.fn(),
		},
	},
}))

// The provider delegates the decision and the effects to `HarnessModeRunner`; both
// halves are replaced so the spec exercises only the provider's own guard logic.
vi.mock("../../harness/mode-runner", () => ({
	HarnessModeRunner: class {
		run = runHarness
		continue = continueHarness
		resume = vi.fn()
		approvePlan = approveHarness
	},
}))

// `approvePlanTask` resolves the canonical lifecycle state before delegating, like
// `resumeBlockedTask`; the resolver is replaced so the spec controls the status.
vi.mock("@roo-code/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@roo-code/core")>()
	return {
		...actual,
		TaskStateResolver: class {
			resolve = resolveState
		},
	}
})

import { ClineProvider, startTaskUnlessLifecycleAdvanced } from "../ClineProvider"

/** The stub used as `this`: the class under test plus only its collaborators replaced. */
type ProviderStub = ClineProvider & {
	getCurrentTask: ReturnType<typeof vi.fn>
	log: ReturnType<typeof vi.fn>
	getValue: ReturnType<typeof vi.fn>
	getState: ReturnType<typeof vi.fn>
	delegateParentAndOpenChild: ReturnType<typeof vi.fn>
	taskHistoryStore: { get: ReturnType<typeof vi.fn> }
}

type TaskStub = {
	taskId: string
	parentTaskId: string | undefined
	getTaskMode: ReturnType<typeof vi.fn>
	getTaskContext: ReturnType<typeof vi.fn>
}

function makeProvider(overrides: { mode?: string; history?: Record<string, unknown>; parentTaskId?: string } = {}): {
	task: TaskStub
	provider: ProviderStub
} {
	const task = {
		taskId: "SITESUP-1119",
		parentTaskId: overrides.parentTaskId,
		getTaskMode: vi.fn().mockResolvedValue(overrides.mode ?? "architect"),
		getTaskContext: vi.fn().mockResolvedValue({
			taskId: "SITESUP-1119",
			branch: "feature/SITESUP-1119",
			taskRoot: "/workspace/.roo/tasks/SITESUP-1119",
		}),
	}

	// `Object.create` keeps the real prototype methods on the receiver, so the
	// provider's own composition (its private helpers) runs unmodified while every
	// collaborator is a stub.
	const provider = Object.assign(Object.create(ClineProvider.prototype) as ProviderStub, {
		getCurrentTask: vi.fn(() => task),
		log: vi.fn(),
		getValue: vi.fn().mockReturnValue(true),
		getState: vi.fn().mockResolvedValue({ customModes: [] }),
		delegateParentAndOpenChild: vi.fn().mockResolvedValue(task),
		taskHistoryStore: { get: vi.fn(() => overrides.history) },
	})

	return { task, provider }
}

describe("ClineProvider.continueTaskLifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		continueHarness.mockResolvedValue({ type: "started", mode: "code", status: "IMPLEMENTATION" })
		runHarness.mockResolvedValue({ type: "started", mode: "code", status: "IMPLEMENTATION" })
	})

	it("advances the canonical state for a lifecycle mode", async () => {
		const { provider, task } = makeProvider()

		expect(await provider.continueTaskLifecycle(task as unknown as Task)).toBe(true)
		expect(continueHarness).toHaveBeenCalledWith(task, { requirePlanApproval: true })
		expect(runHarness).not.toHaveBeenCalled()
	})

	it("forwards the persisted approval setting to the runner", async () => {
		const { provider, task } = makeProvider()
		provider.getValue.mockReturnValue(false)

		await provider.continueTaskLifecycle(task as unknown as Task)

		expect(continueHarness).toHaveBeenCalledWith(task, { requirePlanApproval: false })
	})

	it("declines a delegated child: it must run its own stage", async () => {
		const { provider, task } = makeProvider({ mode: "code", parentTaskId: "parent-1" })

		expect(await provider.continueTaskLifecycle(task as unknown as Task)).toBe(false)
		expect(continueHarness).not.toHaveBeenCalled()
		expect(runHarness).not.toHaveBeenCalled()
	})

	it("routes a reported stage result through the stage-outcome path", async () => {
		const { provider, task } = makeProvider({ mode: "architect" })

		expect(
			await provider.continueTaskLifecycle(task as unknown as Task, "Plan ready.\nStage Result: COMPLETED"),
		).toBe(true)
		expect(runHarness).toHaveBeenCalledWith(task, "architect", "Plan ready.\nStage Result: COMPLETED", {
			requirePlanApproval: true,
		})
		expect(continueHarness).not.toHaveBeenCalled()
	})

	it("tells the user the plan awaits approval when the chain stops at PLAN_READY", async () => {
		const { provider, task } = makeProvider({ mode: "architect" })
		runHarness.mockResolvedValue({ type: "stopped", status: "PLAN_READY", reason: "plan-approval" })

		expect(await provider.continueTaskLifecycle(task as unknown as Task, "Stage Result: COMPLETED")).toBe(true)
		expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("waiting for plan approval"))
	})

	it("declines a non-lifecycle mode without consulting the runner", async () => {
		const { provider, task } = makeProvider({ mode: "debug" })

		expect(await provider.continueTaskLifecycle(task as unknown as Task, "Stage Result: COMPLETED")).toBe(false)
		expect(runHarness).not.toHaveBeenCalled()
		expect(continueHarness).not.toHaveBeenCalled()
	})

	it("declines when a delegated stage is already in flight", async () => {
		const { provider, task } = makeProvider({ history: { id: "SITESUP-1119", status: "delegated" } })

		expect(await provider.continueTaskLifecycle(task as unknown as Task)).toBe(false)
		expect(continueHarness).not.toHaveBeenCalled()
	})

	it("declines when the task already awaits a child", async () => {
		const { provider, task } = makeProvider({
			history: { id: "SITESUP-1119", status: "active", awaitingChildId: "child-1" },
		})

		expect(await provider.continueTaskLifecycle(task as unknown as Task)).toBe(false)
		expect(continueHarness).not.toHaveBeenCalled()
	})

	it("keeps the existing path when the runner reports that the lifecycle cannot advance", async () => {
		const { provider, task } = makeProvider()
		continueHarness.mockResolvedValue(null)

		expect(await provider.continueTaskLifecycle(task as unknown as Task)).toBe(false)
	})

	it("degrades to the existing path when routing throws", async () => {
		const { provider, task } = makeProvider()
		continueHarness.mockRejectedValue(new Error("boom"))

		expect(await provider.continueTaskLifecycle(task as unknown as Task)).toBe(false)
		expect(provider.log).toHaveBeenCalledWith(expect.stringContaining("Lifecycle routing failed"))
	})

	it("degrades to the existing path when the task mode cannot be resolved", async () => {
		const { provider, task } = makeProvider()
		task.getTaskMode.mockRejectedValue(new Error("mode not ready"))

		expect(await provider.continueTaskLifecycle(task as unknown as Task)).toBe(false)
		expect(continueHarness).not.toHaveBeenCalled()
	})
})

describe("startTaskUnlessLifecycleAdvanced", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("skips the ordinary start when the harness started the next stage", async () => {
		const schedule = vi.fn().mockResolvedValue(undefined)
		const task = { taskId: "SITESUP-1119" }

		await startTaskUnlessLifecycleAdvanced(
			{ continueTaskLifecycle: vi.fn().mockResolvedValue(true) },
			{ schedule } as never,
			task as never,
			"createTask",
		)

		expect(schedule).not.toHaveBeenCalled()
	})

	it("starts the task when the lifecycle cannot advance", async () => {
		const schedule = vi.fn().mockResolvedValue(undefined)
		const task = { taskId: "SITESUP-1119" }

		await startTaskUnlessLifecycleAdvanced(
			{ continueTaskLifecycle: vi.fn().mockResolvedValue(false) },
			{ schedule } as never,
			task as never,
			"createTask",
		)

		expect(schedule).toHaveBeenCalledWith(task, expect.any(Function))
	})

	it("starts the task when routing fails, so a stage result is never lost", async () => {
		const schedule = vi.fn().mockResolvedValue(undefined)
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const task = { taskId: "SITESUP-1119" }

		await startTaskUnlessLifecycleAdvanced(
			{ continueTaskLifecycle: vi.fn().mockRejectedValue(new Error("boom")) },
			{ schedule } as never,
			task as never,
			"createTask",
		)

		expect(schedule).toHaveBeenCalledTimes(1)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Lifecycle routing failed"))

		warn.mockRestore()
	})
})

describe("ClineProvider.continueTaskLifecycleFromCommand", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		continueHarness.mockResolvedValue({ type: "started", mode: "code", status: "IMPLEMENTATION" })
	})

	it("tells the user when there is no active task", async () => {
		const { provider } = makeProvider()
		provider.getCurrentTask.mockReturnValue(undefined)

		await provider.continueTaskLifecycleFromCommand()

		expect(showInformationMessage).toHaveBeenCalledWith("No active task to advance.")
		expect(continueHarness).not.toHaveBeenCalled()
	})

	it("reports that the lifecycle is unchanged when it cannot advance", async () => {
		const { provider } = makeProvider({ mode: "debug" })

		await provider.continueTaskLifecycleFromCommand()

		expect(showInformationMessage).toHaveBeenCalledWith(
			expect.stringContaining("cannot be advanced programmatically"),
		)
	})

	it("stays quiet when the harness advanced the lifecycle", async () => {
		const { provider } = makeProvider({ mode: "code" })

		await provider.continueTaskLifecycleFromCommand()

		expect(continueHarness).toHaveBeenCalledTimes(1)
		expect(showInformationMessage).not.toHaveBeenCalled()
	})
})

function planReadyState(status = "PLAN_READY") {
	return {
		taskId: "SITESUP-1119",
		status,
		currentTask: null,
		currentTaskArtifact: null,
		failureKey: null,
		failureAttempts: 0,
	}
}

describe("ClineProvider.approvePlanTask", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		approveHarness.mockResolvedValue({ type: "started", mode: "code", status: "IMPLEMENTATION" })
	})

	it("does nothing when there is no current task", async () => {
		const { provider } = makeProvider()
		provider.getCurrentTask.mockReturnValue(undefined)

		await provider.approvePlanTask()

		expect(showInformationMessage).toHaveBeenCalledWith("No active task to approve.")
		expect(approveHarness).not.toHaveBeenCalled()
	})

	it("does not prompt when the task is not waiting for approval", async () => {
		const { provider } = makeProvider()
		resolveState.mockResolvedValue(planReadyState("IMPLEMENTATION"))

		await provider.approvePlanTask()

		expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("is not waiting for plan approval"))
		expect(showWarningMessage).not.toHaveBeenCalled()
		expect(approveHarness).not.toHaveBeenCalled()
	})

	it("leaves the task unchanged when the user does not confirm", async () => {
		const { provider } = makeProvider()
		resolveState.mockResolvedValue(planReadyState())
		showWarningMessage.mockResolvedValue(undefined)

		await provider.approvePlanTask()

		expect(showWarningMessage).toHaveBeenCalledWith(expect.any(String), { modal: true }, "Approve")
		expect(approveHarness).not.toHaveBeenCalled()
	})

	it("approves the plan after the user confirms", async () => {
		const { provider, task } = makeProvider()
		resolveState.mockResolvedValue(planReadyState())
		showWarningMessage.mockResolvedValue("Approve")

		await provider.approvePlanTask()

		expect(approveHarness).toHaveBeenCalledWith(task)
	})

	it("warns when the harness cannot approve the task", async () => {
		const { provider } = makeProvider()
		resolveState.mockResolvedValue(planReadyState())
		showWarningMessage.mockResolvedValue("Approve")
		approveHarness.mockResolvedValue(null)

		await provider.approvePlanTask()

		expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("could not be approved"))
	})

	it("reports a state resolution failure without approving", async () => {
		const { provider } = makeProvider()
		resolveState.mockRejectedValue(new Error("boom"))

		await provider.approvePlanTask()

		expect(showErrorMessage).toHaveBeenCalledWith("Could not read the task lifecycle state.")
		expect(approveHarness).not.toHaveBeenCalled()
	})
})
