// npx vitest run core/webview/__tests__/ClineProvider.resume-blocked-task.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import * as vscode from "vscode"

import type { TaskContext, TaskState } from "@roo-code/core"

const resolveState = vi.hoisted(() => vi.fn())
const resumeHarness = vi.hoisted(() => vi.fn())
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

// The provider resolves the lifecycle state through `TaskStateResolver`; the
// resume itself is delegated to `HarnessModeRunner`. Both are replaced so the
// spec exercises only the provider's own decision logic.
vi.mock("@roo-code/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@roo-code/core")>()
	return {
		...actual,
		TaskStateResolver: class {
			resolve = resolveState
		},
	}
})

vi.mock("../../harness/mode-runner", () => ({
	HarnessModeRunner: class {
		resume = resumeHarness
	},
}))

import { ClineProvider } from "../ClineProvider"

const context: TaskContext = {
	taskId: "SITESUP-1119",
	branch: "feature/SITESUP-1119",
	taskRoot: "/workspace/.roo/tasks/SITESUP-1119",
}

function blockedState(overrides: Partial<TaskState> = {}): TaskState {
	return {
		taskId: "SITESUP-1119",
		status: "BLOCKED",
		currentTask: null,
		currentTaskArtifact: null,
		failureKey: null,
		failureAttempts: 0,
		...overrides,
	}
}

function makeProvider() {
	const task = {
		taskId: "SITESUP-1119",
		getTaskContext: vi.fn().mockResolvedValue(context),
	}

	// `Object.create` keeps the real prototype methods on the receiver, so the
	// provider composes its own harness adapter unmodified while every collaborator
	// is a stub.
	return {
		task,
		provider: Object.assign(Object.create(ClineProvider.prototype), {
			getCurrentTask: vi.fn<() => typeof task | undefined>(() => task),
			log: vi.fn(),
			getState: vi.fn().mockResolvedValue({ customModes: [] }),
			delegateParentAndOpenChild: vi.fn().mockResolvedValue(task),
		}),
	}
}

/**
 * Call the provider method with a structural stub. The stub is not a real
 * `ClineProvider`, so the cast is unavoidable; it is confined to this helper.
 */
async function runResume(provider: ReturnType<typeof makeProvider>["provider"]): Promise<void> {
	await ClineProvider.prototype.resumeBlockedTask.call(provider as unknown as ClineProvider)
}

describe("ClineProvider.resumeBlockedTask", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		resumeHarness.mockResolvedValue({ type: "started", mode: "code", status: "IMPLEMENTATION" })
	})

	it("does nothing when there is no current task", async () => {
		const { provider } = makeProvider()
		provider.getCurrentTask.mockReturnValue(undefined)

		await runResume(provider)

		expect(showInformationMessage).toHaveBeenCalledWith("No active task to resume.")
		expect(resumeHarness).not.toHaveBeenCalled()
	})

	it("does not prompt when the task is not blocked", async () => {
		const { provider } = makeProvider()
		resolveState.mockResolvedValue(blockedState({ status: "IMPLEMENTATION" }))

		await runResume(provider)

		expect(showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("is not blocked"))
		expect(showWarningMessage).not.toHaveBeenCalled()
		expect(resumeHarness).not.toHaveBeenCalled()
	})

	it("leaves the task unchanged when the user does not confirm the Unblock Condition", async () => {
		const { provider } = makeProvider()
		resolveState.mockResolvedValue(blockedState())
		showWarningMessage.mockResolvedValue(undefined)

		await runResume(provider)

		expect(showWarningMessage).toHaveBeenCalledWith(
			expect.stringContaining("Confirm that the recorded Unblock Condition is met"),
			{ modal: true },
			"Resume",
		)
		expect(resumeHarness).not.toHaveBeenCalled()
	})

	it("resumes the blocked task after the user confirms the Unblock Condition", async () => {
		const { provider, task } = makeProvider()
		resolveState.mockResolvedValue(blockedState())
		showWarningMessage.mockResolvedValue("Resume")

		await runResume(provider)

		expect(resumeHarness).toHaveBeenCalledWith(task, true)
	})

	it("warns when the harness cannot resume the task", async () => {
		const { provider } = makeProvider()
		resolveState.mockResolvedValue(blockedState())
		showWarningMessage.mockResolvedValue("Resume")
		resumeHarness.mockResolvedValue(null)

		await runResume(provider)

		expect(showWarningMessage).toHaveBeenCalledWith(expect.stringContaining("could not be resumed"))
	})

	it("reports a state resolution failure without resuming", async () => {
		const { provider } = makeProvider()
		resolveState.mockRejectedValue(new Error("boom"))

		await runResume(provider)

		expect(showErrorMessage).toHaveBeenCalledWith("Could not read the task lifecycle state.")
		expect(resumeHarness).not.toHaveBeenCalled()
	})
})
