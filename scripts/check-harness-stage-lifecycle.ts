import {
	LifecycleController,
	MAX_FAILURE_ATTEMPTS,
	MAX_TOTAL_FAILURE_ATTEMPTS,
} from "../packages/core/src/lifecycle/lifecycle-controller"
import { isTaskStatusTransition, type TaskState, type TaskStatus } from "../packages/core/src/worktree/task-state"
import {
	LIFECYCLE_MODES,
	STAGE_RESULTS,
	type FailureTracking,
	type LifecycleResult,
	type StageOutcome,
} from "../packages/core/src/lifecycle/lifecycle-types"

/**
 * Harness stage lifecycle model check
 *
 * An explicit-state exploration of the README status machine the stage lifecycle
 * drives: `ANALYSIS → … → QA_READY → DONE`. Unlike the controller specs, which
 * assert one scripted path at a time, this check enumerates *every* interleaving
 * of stage outcomes and harness actions up to the bounds below and proves the
 * invariants that make the chain self-driving:
 *
 * 1. the fix-pass budgets hold in every reachable state (no spin),
 * 2. `DONE` is reachable from every reachable state (no livelock/deadlock),
 * 3. `DONE` is absorbing (no stage outcome leaves it),
 * 4. `PLAN_READY` is exit-only through `approvePlan` (the plan gate),
 * 5. `BLOCKED` is exit-only through `resume` (the unblock gate),
 * 6. every producible `blockedFrom` origin resumes into its recorded stage,
 * 7. every written status is a canonical `TASK_STATUS_TRANSITIONS` edge,
 * 8. every stage decision in the model's stage table is reachable.
 *
 * The model imports the production `LifecycleController`, `TASK_STATUS_TRANSITIONS`
 * and the stage/mode vocabulary, so a drift between the controller's `decide`
 * logic and the canonical table fails here, not in a live task folder. The
 * scheduler is abstracted to two branches: a queue decision either assigns a
 * ready unit (`IMPLEMENTATION`) or finds every unit done and starts Refactor
 * (`READY_FOR_REFACTOR`). `LifecycleController.resolve` shares `decide` and the
 * same guards, so its edges are the same ones explored here.
 */

const controller = new LifecycleController()

const MAX_DEPTH = 30
const MAX_STATES = 10_000

/** Failure-key identity for the exploration: bounded, plus `null` for "no key". */
const FAILURE_KEYS = ["finding-a", "finding-b", "finding-c"] as const
type FailureKey = (typeof FAILURE_KEYS)[number] | null

/**
 * The README half of a model state: the `Status` line plus the failure-tracking
 * block. `Current Task` is omitted because no decision reads it.
 */
interface ModelState {
	status: TaskStatus
	key: FailureKey
	attempts: number
	total: number
	blockedFrom: TaskStatus | null
}

interface Transition {
	name: string
	next: ModelState
	/**
	 * The failure tracking a `start_mode` decision carries — present exactly when
	 * the transition starts (or re-verifies) a fix pass, so the budget invariant
	 * can inspect the pass that is being *started*, not the record of an episode
	 * that already exhausted its budget.
	 */
	readonly fixPassStart?: FailureTracking
}

interface TraceStep {
	action: string
	state: ModelState
}

const initial = (): ModelState => ({
	status: "ANALYSIS",
	key: null,
	attempts: 0,
	total: 0,
	blockedFrom: null,
})

function toTaskState(state: ModelState): TaskState {
	return {
		taskId: "MODEL",
		status: state.status,
		currentTask: null,
		currentTaskArtifact: null,
		failureKey: state.key,
		failureAttempts: state.attempts,
		totalFailureAttempts: state.total,
		blockedFrom: state.blockedFrom,
	}
}

/**
 * Project a controller decision onto the README state(s) the runner would write.
 *
 * A queue decision (`schedule_implementation`, `reschedule_implementation`,
 * `resume_implementation`) defers the write to `TaskScheduler`: the runner first
 * writes the queue state `READY_FOR_IMPLEMENTATION`, then the scheduler either
 * assigns a ready unit (`IMPLEMENTATION`) or finds every unit done and starts
 * Refactor (`READY_FOR_REFACTOR`). The queue write is one explored event; the
 * two scheduler continuations are events of the queue state itself (see
 * `schedulerEvents`), because a task parked in the queue re-enters the same
 * continuation on the next run. Every other decision writes exactly one state,
 * mirroring `ModeRunner.writeState`.
 */
function project(name: string, decision: LifecycleResult): Transition[] {
	if (decision.type === "invalid") {
		return []
	}

	if (
		decision.type === "schedule_implementation" ||
		decision.type === "reschedule_implementation" ||
		decision.type === "resume_implementation"
	) {
		return [
			{
				name: `${name}:queue`,
				next: { status: "READY_FOR_IMPLEMENTATION", key: null, attempts: 0, total: 0, blockedFrom: null },
			},
		]
	}

	const failure = decision.failure
	const next: ModelState = {
		status: decision.status,
		key: failure?.key ?? null,
		attempts: failure?.attempts ?? 0,
		total: failure?.total ?? 0,
		blockedFrom: decision.type === "stop" ? (decision.blockedFrom ?? null) : null,
	}
	const fixPassStart = decision.type === "start_mode" ? decision.failure : undefined
	return [{ name, next, fixPassStart }]
}

/**
 * The continuations `TaskScheduler` produces from a task parked in the
 * implementation queue: assign the next ready unit, or find the DAG drained and
 * start Refactor. Both are canonical writes; a new scheduler outcome belongs in
 * `TASK_STATUS_TRANSITIONS` first.
 */
function schedulerEvents(state: ModelState): Transition[] {
	if (state.status !== "READY_FOR_IMPLEMENTATION") {
		return []
	}

	const cleared = { key: null, attempts: 0, total: 0, blockedFrom: null }
	return [
		{ name: "scheduler:assign-unit", next: { ...state, status: "IMPLEMENTATION", ...cleared } },
		{ name: "scheduler:all-units-done", next: { ...state, status: "READY_FOR_REFACTOR", ...cleared } },
	]
}

/** The rename choice for a fix pass that reports a fresh key, kept inside the bounded keyspace. */
function renamedKey(state: ModelState): Exclude<FailureKey, null> {
	return FAILURE_KEYS.find((key) => key !== state.key) ?? "finding-a"
}

/**
 * The events a stage outcome produces from `state`: each (mode, result) pair
 * crossed with the failure-key relations the protocol allows (`none`, the
 * carried-over key, or a fresh key), plus the three harness-owned actions.
 */
function events(state: ModelState): Transition[] {
	const result: Transition[] = []

	for (const mode of LIFECYCLE_MODES) {
		for (const stageResult of STAGE_RESULTS) {
			const isFixReport =
				stageResult === "REQUIRED" ||
				stageResult === "PRODUCTION_FIX_REQUIRED" ||
				stageResult === "FUNCTIONAL_DEFECT" ||
				stageResult === "FAILED"
			const keys: FailureKey[] = isFixReport ? [null, state.key, renamedKey(state)] : [null]

			for (const key of keys) {
				const relation = key === null ? "none" : key === state.key ? "same" : "renamed"
				const outcome: StageOutcome = { mode, result: stageResult, failureKey: key }
				result.push(
					...project(
						`stage:${mode}:${stageResult}:${relation}`,
						controller.transition(toTaskState(state), outcome),
					),
				)
			}
		}
	}

	const actions: Array<{ name: string; decision: LifecycleResult }> = [
		{ name: "action:approvePlan", decision: controller.approvePlan(toTaskState(state)) },
		{ name: "action:approveQa", decision: controller.approveQa(toTaskState(state)) },
		{ name: "action:resume", decision: controller.resume(toTaskState(state), true) },
	]

	for (const { name, decision } of actions) {
		result.push(...project(name, decision))
	}

	result.push(...schedulerEvents(state))

	return result
}

/**
 * The state a resume must land in for each recorded origin, mirroring
 * `LifecycleController.resume`. Queue origins resume into the queue write; stage
 * origins resume into the stage's entry status. A producer of a `BLOCKED` record
 * whose origin is missing here is a bug: the resume could never route back.
 */
const RESUME_ENTRIES: Partial<Record<TaskStatus, readonly TaskStatus[]>> = {
	ANALYSIS: ["ANALYSIS"],
	IMPLEMENTATION: ["READY_FOR_IMPLEMENTATION"],
	READY_FOR_IMPLEMENTATION: ["READY_FOR_IMPLEMENTATION"],
	READY_FOR_REFACTOR: ["READY_FOR_REFACTOR"],
	REFACTOR: ["READY_FOR_REFACTOR"],
	READY_FOR_REVIEW: ["READY_FOR_REVIEW"],
	REVIEW: ["READY_FOR_REVIEW"],
	REVIEW_PASSED: ["REVIEW_PASSED"],
	QA_READY: ["REVIEW_PASSED"],
}

const stateInvariants = {
	"blocked records carry a resumable origin": (state: ModelState): string | undefined => {
		if (state.status !== "BLOCKED") {
			return undefined
		}
		// A legacy record with no origin falls back to the implementation queue,
		// which `RESUME_ENTRIES` covers; a recorded origin it cannot cover is a
		// dead end the resume would refuse.
		return state.blockedFrom !== null && !(state.blockedFrom in RESUME_ENTRIES)
			? `BLOCKED was recorded from ${state.blockedFrom}, which has no resume entry`
			: undefined
	},
} satisfies Record<string, (state: ModelState) => string | undefined>

const transitionInvariants = {
	/**
	 * The budgets bound the fix passes the harness *starts*: a new pass is a
	 * start whose `total` advanced by one (`startFixPass` always increments it),
	 * while a resume or a re-verification carries the previous counters unchanged.
	 * A stop that records an exhausted budget is a legal record; starting a new
	 * pass beyond either budget would spin the loop, and `startFixPass` stops
	 * instead, so no reachable new pass carries counters past the caps.
	 */
	"no new fix pass starts beyond the budgets": (previous: ModelState, transition: Transition): string | undefined => {
		const failure = transition.fixPassStart
		return failure &&
			failure.total === previous.total + 1 &&
			(failure.attempts > MAX_FAILURE_ATTEMPTS || failure.total > MAX_TOTAL_FAILURE_ATTEMPTS)
			? `${transition.name} starts a fix pass beyond the budgets (attempts=${failure.attempts}/${MAX_FAILURE_ATTEMPTS}, total=${failure.total}/${MAX_TOTAL_FAILURE_ATTEMPTS})`
			: undefined
	},
	"every written status is a canonical transition": (
		previous: ModelState,
		transition: Transition,
	): string | undefined =>
		transition.next.status !== previous.status && !isTaskStatusTransition(previous.status, transition.next.status)
			? `${transition.name} writes ${previous.status} -> ${transition.next.status}, which is not a canonical task status transition`
			: undefined,
	"DONE is absorbing": (previous: ModelState, transition: Transition): string | undefined =>
		previous.status === "DONE" ? `${transition.name} leaves DONE` : undefined,
	"PLAN_READY only exits through approvePlan": (previous: ModelState, transition: Transition): string | undefined =>
		previous.status === "PLAN_READY" && !transition.name.startsWith("action:approvePlan")
			? `${transition.name} leaves PLAN_READY without the plan gate`
			: undefined,
	"BLOCKED only exits through resume": (previous: ModelState, transition: Transition): string | undefined =>
		previous.status === "BLOCKED" && !transition.name.startsWith("action:resume")
			? `${transition.name} leaves BLOCKED without the unblock gate`
			: undefined,
	"resume returns to the recorded origin's stage": (
		previous: ModelState,
		transition: Transition,
	): string | undefined => {
		if (!transition.name.startsWith("action:resume") || previous.status !== "BLOCKED") {
			return undefined
		}
		const origin = previous.blockedFrom ?? "READY_FOR_IMPLEMENTATION"
		const expected = RESUME_ENTRIES[origin]
		return expected !== undefined && !expected.some((status) => status === transition.next.status)
			? `resume from origin ${origin} entered ${transition.next.status}, expected one of ${expected.join(", ")}`
			: undefined
	},
} satisfies Record<string, (previous: ModelState, transition: Transition) => string | undefined>

const semanticLandmarks = {
	"plan-approval-gate": (state: ModelState) => state.status === "PLAN_READY",
	"implementation-queue": (state: ModelState) => state.status === "IMPLEMENTATION",
	"refactor-entry": (state: ModelState) => state.status === "READY_FOR_REFACTOR",
	"review-entry": (state: ModelState) => state.status === "READY_FOR_REVIEW",
	"qa-entry": (state: ModelState) => state.status === "REVIEW_PASSED",
	"qa-ready-pending-gate": (state: ModelState) =>
		state.status === "QA_READY" && state.key === null && state.attempts === 0,
	"qa-fix-pass-in-flight": (state: ModelState) => state.status === "QA_READY" && state.attempts > 0,
	"review-fix-pass-in-flight": (state: ModelState) => state.status === "REVIEW" && state.attempts > 0,
	"refactor-fix-pass-in-flight": (state: ModelState) => state.status === "REFACTOR" && state.attempts > 0,
	"blocked-with-origin": (state: ModelState) => state.status === "BLOCKED" && state.blockedFrom !== null,
	"blocked-budget-exhausted": (state: ModelState) =>
		state.status === "BLOCKED" &&
		(state.attempts === MAX_FAILURE_ATTEMPTS || state.total > MAX_TOTAL_FAILURE_ATTEMPTS),
	"reverify-preserves-budget": (state: ModelState) => state.status === "REVIEW_PASSED" && state.attempts > 0,
	done: (state: ModelState) => state.status === "DONE",
} satisfies Record<string, (state: ModelState) => boolean>

const expectedActions = [
	"stage:sublimation:COMPLETED:none",
	"stage:code:COMPLETED:none:queue",
	"stage:code:RESCHEDULE_REQUIRED:none:queue",
	"scheduler:assign-unit",
	"scheduler:all-units-done",
	"stage:refactor:COMPLETED:none",
	"stage:refactor:FUNCTIONAL_DEFECT:same",
	"stage:reviewer:PASSED:none",
	"stage:reviewer:REQUIRED:same",
	"stage:qa:PENDING:none",
	"stage:qa:PASSED:none",
	"stage:qa:FAILED:same",
	"stage:qa:BLOCKED:none",
	"action:approvePlan:queue",
	"action:approveQa",
	"action:resume",
	"action:resume:queue",
] as const

function canonical(state: ModelState): string {
	return JSON.stringify(state)
}

function formatCounterexample(message: string, trace: TraceStep[]): string {
	return [
		`Harness stage lifecycle invariant failed: ${message}`,
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}`,
		...trace.map((step, index) => `${index}. ${step.action}\n${JSON.stringify(step.state, null, 2)}`),
	].join("\n")
}

function invariantViolations(state: ModelState): string[] {
	return Object.entries(stateInvariants).flatMap(([name, check]) => {
		const violation = check(state)
		return violation ? [`${name}: ${violation}`] : []
	})
}

function transitionViolations(previous: ModelState, transition: Transition): string[] {
	return Object.entries(transitionInvariants).flatMap(([name, check]) => {
		const violation = check(previous, transition)
		return violation ? [`${name}: ${violation}`] : []
	})
}

function runModelCheck(): number {
	const start = initial()
	const queue: Array<{ state: ModelState; trace: TraceStep[] }> = [
		{ state: start, trace: [{ action: "initial", state: start }] },
	]
	const visited = new Map<string, ModelState>([[canonical(start), start]])
	const edges = new Map<string, string[]>()
	const reachedActions = new Set<string>()
	const reachedLandmarks = new Set<string>()
	const frontier: ModelState[] = []

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		const stateKey = canonical(node.state)

		for (const [name, predicate] of Object.entries(semanticLandmarks)) {
			if (predicate(node.state)) reachedLandmarks.add(name)
		}
		const violations = invariantViolations(node.state)
		if (violations.length) throw new Error(formatCounterexample(violations.join("; "), node.trace))
		if (node.trace.length - 1 === MAX_DEPTH) {
			frontier.push(node.state)
			continue
		}

		const next = events(node.state)
		edges.set(
			stateKey,
			next.map((transition) => canonical(transition.next)).filter((key) => key !== stateKey),
		)

		for (const transition of next) {
			reachedActions.add(transition.name)
			const trace = [...node.trace, { action: transition.name, state: transition.next }]
			const violations = transitionViolations(node.state, transition)
			if (violations.length) throw new Error(formatCounterexample(violations.join("; "), trace))

			const key = canonical(transition.next)
			if (visited.has(key)) continue
			visited.set(key, transition.next)
			queue.push({ state: transition.next, trace })
			if (visited.size > MAX_STATES) {
				throw new Error(`Harness stage lifecycle exploration exceeded its ${MAX_STATES}-state budget`)
			}
		}
	}

	const unreachableActions = expectedActions.filter((action) => !reachedActions.has(action))
	if (unreachableActions.length) {
		throw new Error(`Harness stage lifecycle model has unreachable actions: ${unreachableActions.join(", ")}`)
	}
	const missingLandmarks = Object.keys(semanticLandmarks).filter((name) => !reachedLandmarks.has(name))
	if (missingLandmarks.length) {
		throw new Error(`Harness stage lifecycle model has unreachable landmarks: ${missingLandmarks.join(", ")}`)
	}

	// Liveness: every reachable state can reach DONE. Backward BFS from the DONE
	// states over the explored edges; an unmarked visited state is a livelock the
	// chain could not leave without a human.
	const reverse = new Map<string, string[]>()
	for (const [from, targets] of edges) {
		for (const to of targets) {
			const list = reverse.get(to) ?? []
			list.push(from)
			reverse.set(to, list)
		}
	}
	const doneKeys = [...visited.values()].filter((state) => state.status === "DONE").map(canonical)
	const ancestors = new Set(doneKeys)
	const stack = [...doneKeys]
	while (stack.length > 0) {
		const key = stack.pop()!
		for (const from of reverse.get(key) ?? []) {
			if (!ancestors.has(from)) {
				ancestors.add(from)
				stack.push(from)
			}
		}
	}
	const livelocked = [...visited.keys()].filter((key) => !ancestors.has(key))
	if (livelocked.length > 0) {
		throw new Error(
			`Harness stage lifecycle has ${livelocked.length} reachable state(s) that cannot reach DONE, e.g. ${livelocked[0]}`,
		)
	}

	const unexploredSuccessor = frontier
		.flatMap((state) => events(state))
		.find((transition) => !visited.has(canonical(transition.next)))
	if (unexploredSuccessor) {
		throw new Error(
			`Harness stage lifecycle exploration reached depth ${MAX_DEPTH} with an unseen successor (${unexploredSuccessor.name})`,
		)
	}

	return visited.size
}

const checkedStates = runModelCheck()
const invariantCount = Object.keys(stateInvariants).length + Object.keys(transitionInvariants).length
console.log(
	`Harness stage lifecycle model check passed: ${checkedStates} states, ` +
		`${expectedActions.length}/${expectedActions.length} stage actions reachable, ` +
		`${invariantCount} invariants, ${Object.keys(semanticLandmarks).length}/${Object.keys(semanticLandmarks).length} landmarks reached, ` +
		`depth <= ${MAX_DEPTH}, budgets <= ${MAX_FAILURE_ATTEMPTS}/${MAX_TOTAL_FAILURE_ATTEMPTS}`,
)
