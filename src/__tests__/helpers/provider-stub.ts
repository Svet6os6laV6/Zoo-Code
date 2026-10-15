import type { HarnessLogContextInput } from "@roo-code/core"

import { ClineProvider } from "../../core/webview/ClineProvider"
import { TaskRegistry } from "../../core/task/TaskRegistry"
import { type Task } from "../../core/task/Task"
import type { HistoryItem } from "@roo-code/types"

type ProviderStubFields = {
	cancelledDelegationChildIds?: Set<string>
	stageRestartBudgets?: Map<string, { mode: string; count: number }>
	shouldPauseStageRestart?: unknown
	notifyStageStuck?: unknown
	safeHarnessLogContext?: unknown
	log?: ReturnType<typeof vi.fn>
	getValue?: ReturnType<typeof vi.fn>
	taskHistoryStore?: { get: (id: string) => unknown; invalidate?: (id: string) => Promise<void> }
	taskScheduler?: { schedule: (task: Task, run: () => Promise<void>) => Promise<void> }
	taskRegistry?: TaskRegistry
	clineStack?: Task[]
	tasks?: Task[]
	runDelegationTransition?: unknown
	removeClineFromStack?: unknown
	evictCurrentTask?: unknown
	requirePlanApproval?: unknown
}

type PrivateProviderMethods = {
	runDelegationTransition: (this: unknown, ...args: unknown[]) => unknown
	removeClineFromStack: (this: unknown, ...args: unknown[]) => unknown
	evictCurrentTask: (this: unknown, ...args: unknown[]) => unknown
	requirePlanApproval: (this: unknown) => boolean
	shouldPauseStageRestart: (
		this: unknown,
		parentTaskId: string,
		parentInstance: Task,
		childHistory: HistoryItem,
	) => Promise<boolean>
	notifyStageStuck: (this: unknown, ...args: unknown[]) => Promise<void>
	safeHarnessLogContext: (this: unknown, task: Task) => Promise<HarnessLogContextInput | undefined>
}

/**
 * Augments a plain stub object with the instance fields and bound methods that
 * ClineProvider methods read from `this` (runDelegationTransition,
 * cancelledDelegationChildIds and taskHistoryStore),
 * so tests can call private ClineProvider methods against a plain object
 * without instantiating a real ClineProvider.
 *
 * Pass `tasks` (array of Task mocks) to pre-seed the registry in stack order.
 * The legacy `clineStack` key is accepted and converted automatically.
 */
export function makeProviderStub<T extends object>(stub: T): ClineProvider {
	const s = stub as T & ProviderStubFields
	const proto = ClineProvider.prototype as unknown as PrivateProviderMethods
	s.cancelledDelegationChildIds ??= new Set()
	s.stageRestartBudgets ??= new Map()
	s.log ??= vi.fn()
	// The lifecycle reads the `requirePlanApproval` setting through `getValue`;
	// default it to the persisted default so provider paths stay deterministic.
	s.getValue ??= vi.fn(() => true)
	s.taskHistoryStore ??= { get: () => undefined }
	s.taskHistoryStore.invalidate ??= async () => {}
	s.taskScheduler ??= { schedule: async (_task, run) => run() }

	// Convert legacy clineStack array into a TaskRegistry
	if (!s.taskRegistry) {
		const registry = new TaskRegistry()
		const seed: Task[] = s.clineStack ?? s.tasks ?? []
		for (const t of seed) registry.push(t)
		s.taskRegistry = registry
	}
	delete s.clineStack

	s.runDelegationTransition ??= proto.runDelegationTransition.bind(s)
	s.removeClineFromStack ??= proto.removeClineFromStack.bind(s)
	s.evictCurrentTask ??= proto.evictCurrentTask.bind(s)
	// The plain stub has no `ClineProvider` prototype, so the private lifecycle
	// helper must be bound explicitly to read `getValue` from `this`.
	s.requirePlanApproval ??= proto.requirePlanApproval.bind(s)
	// Same for the restart-budget guard the completion routing awaits; a task
	// double without `getTaskContext` degrades it to "do not pause".
	s.shouldPauseStageRestart ??= proto.shouldPauseStageRestart.bind(s)
	// And its notification and log-context helper, reached through the
	// fire-and-forget call in the stuck-stop path.
	s.notifyStageStuck ??= proto.notifyStageStuck.bind(s)
	s.safeHarnessLogContext ??= proto.safeHarnessLogContext.bind(s)
	return s as unknown as ClineProvider
}
