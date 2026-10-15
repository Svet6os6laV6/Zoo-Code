// npx vitest run core/webview/__tests__/ClineProvider.stage-reask.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"

import type { HistoryItem } from "@roo-code/types"

import { STAGE_RE_ASK_PREFIX, buildStageReaskInstruction } from "@roo-code/core"

vi.mock("vscode", () => {
	const window = {
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
		showErrorMessage: vi.fn(),
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

import { ClineProvider } from "../ClineProvider"

/**
 * The stubs `requestStageOutcomeReask` reaches for. The mocks are returned
 * beside the provider instead of typed onto it: `delegateParentAndOpenChildUnlocked`
 * is private on `ClineProvider`, and an intersection that re-declares a private
 * member reduces to `never` — the repo pattern is to keep the mocks as values
 * (see `ClineProvider.continue-lifecycle.spec.ts` returning `{ task, provider }`).
 */
type ReaskMocks = {
	assertLifecycleModeConfigured: ReturnType<typeof vi.fn>
	delegateParentAndOpenChildUnlocked: ReturnType<typeof vi.fn>
	log: ReturnType<typeof vi.fn>
}

function makeProvider(): ReaskMocks & { provider: ClineProvider } {
	const mocks: ReaskMocks = {
		assertLifecycleModeConfigured: vi.fn().mockResolvedValue(undefined),
		delegateParentAndOpenChildUnlocked: vi.fn().mockResolvedValue(undefined),
		log: vi.fn(),
	}

	// `Object.create` keeps the real prototype methods on the receiver, so the
	// provider's own guard logic runs unmodified while every collaborator is a stub.
	const provider = Object.assign(Object.create(ClineProvider.prototype) as ClineProvider, mocks)

	return { provider, ...mocks }
}

function childHistory(overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id: "child-1",
		number: 2,
		ts: 1,
		task: "Run the reviewer stage for SITESUP-1119.",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		mode: "reviewer",
		...overrides,
	} as HistoryItem
}

/**
 * The bounded marker recovery: a stage reply without the outcome marker is
 * re-asked exactly once. The bound is the `STAGE_RE_ASK_PREFIX` on the child's
 * own task record, so a re-ask whose reply again lacks the marker degrades to
 * the state-only continue instead of looping.
 */
describe("ClineProvider.requestStageOutcomeReask", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("delegates one re-ask child when the reply carried no marker at all", async () => {
		const { provider, assertLifecycleModeConfigured, delegateParentAndOpenChildUnlocked } = makeProvider()

		const result = await provider["requestStageOutcomeReask"](
			"parent-1",
			childHistory(),
			"The review found the implementation acceptable.",
		)

		expect(result).toBe(true)
		expect(assertLifecycleModeConfigured).toHaveBeenCalledWith("reviewer")
		expect(delegateParentAndOpenChildUnlocked).toHaveBeenCalledWith({
			parentTaskId: "parent-1",
			message: buildStageReaskInstruction({ mode: "reviewer", taskId: "parent-1" }),
			initialTodos: [],
			mode: "reviewer",
		})
	})

	it("does not re-ask a child that was itself a re-ask", async () => {
		const { provider, delegateParentAndOpenChildUnlocked } = makeProvider()
		const reaskChild = childHistory({
			task: `${STAGE_RE_ASK_PREFIX} run the reviewer stage re-report for parent-1.`,
		})

		const result = await provider["requestStageOutcomeReask"]("parent-1", reaskChild, "still no marker")

		expect(result).toBe(false)
		expect(delegateParentAndOpenChildUnlocked).not.toHaveBeenCalled()
	})

	it("does not re-ask when the reply carries the marker (a parse failure there is ambiguity, not absence)", async () => {
		const { provider, delegateParentAndOpenChildUnlocked } = makeProvider()

		const result = await provider["requestStageOutcomeReask"](
			"parent-1",
			childHistory(),
			"Stage Result: PASSED\nStage Result: PASSED",
		)

		expect(result).toBe(false)
		expect(delegateParentAndOpenChildUnlocked).not.toHaveBeenCalled()
	})

	it("does not re-ask for a non-lifecycle mode", async () => {
		const { provider, delegateParentAndOpenChildUnlocked } = makeProvider()

		const result = await provider["requestStageOutcomeReask"](
			"parent-1",
			childHistory({ mode: "ask" }),
			"no marker here",
		)

		expect(result).toBe(false)
		expect(delegateParentAndOpenChildUnlocked).not.toHaveBeenCalled()
	})

	it("falls back (returns false) when the re-ask delegation fails", async () => {
		const { provider, assertLifecycleModeConfigured, log } = makeProvider()
		assertLifecycleModeConfigured.mockRejectedValue(new Error("mode not configured"))

		const result = await provider["requestStageOutcomeReask"]("parent-1", childHistory(), "no marker")

		expect(result).toBe(false)
		expect(log).toHaveBeenCalledWith(expect.stringContaining("Marker re-ask after child child-1 failed"))
	})
})
