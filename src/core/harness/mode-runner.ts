import {
	ArtifactValidator,
	LifecycleController,
	ModeRunner,
	TaskStateResolver,
	TxxParser,
	harnessLogger,
	parseStageOutcome,
	type HarnessLogContextInput,
	type HarnessLoggerPort,
	type LifecycleMode,
	type LifecycleResult,
	type ModeRunResult,
	type TaskContext,
	type TaskState,
} from "@roo-code/core"

type LifecycleTask = {
	getTaskContext(): Promise<TaskContext>
	/**
	 * The task's harness log identity (`traceId`, `taskId`, ...). Optional so the
	 * adapter still works with a minimal task double; when present, the lifecycle
	 * mutation records are bound to the task's trace instead of the unbound
	 * fallback identity.
	 */
	getHarnessLogContext?(): Promise<HarnessLogContextInput>
}

type HarnessModeRunnerDependencies = {
	readonly stateResolver?: Pick<TaskStateResolver, "resolve">
	readonly controller?: Pick<LifecycleController, "transition" | "resume" | "resolve" | "approvePlan">
	readonly modeRunner?: Pick<ModeRunner, "run">
	readonly parser?: Pick<TxxParser, "read">
	readonly validator?: Pick<ArtifactValidator, "validate">
	/** Explicit injection for tests; defaults to the process-wide harness logger. */
	readonly logger?: HarnessLoggerPort
}

export class HarnessModeRunner {
	private readonly stateResolver: Pick<TaskStateResolver, "resolve">
	private readonly controller: Pick<LifecycleController, "transition" | "resume" | "resolve" | "approvePlan">
	private readonly modeRunner: Pick<ModeRunner, "run">
	private readonly parser: Pick<TxxParser, "read">
	private readonly validator: Pick<ArtifactValidator, "validate">
	private readonly logger?: HarnessLoggerPort

	constructor(
		startMode: (mode: LifecycleMode, message: string) => Promise<void>,
		dependencies: HarnessModeRunnerDependencies = {},
	) {
		this.stateResolver = dependencies.stateResolver ?? new TaskStateResolver()
		this.controller = dependencies.controller ?? new LifecycleController()
		this.modeRunner =
			dependencies.modeRunner ?? new ModeRunner(startMode, undefined, undefined, dependencies.logger)
		this.parser = dependencies.parser ?? new TxxParser()
		this.validator = dependencies.validator ?? new ArtifactValidator()
		this.logger = dependencies.logger
	}

	/**
	 * Advance the lifecycle after a stage reported its result.
	 *
	 * `options.requirePlanApproval` is resolved by the caller from the user
	 * setting and forwarded verbatim: the runner is an adapter and never reads
	 * settings itself, so the controller's decision stays explicit and pure.
	 */
	async run(
		task: LifecycleTask,
		runtimeMode: string,
		resultText: string,
		options: { requirePlanApproval?: boolean } = {},
	): Promise<ModeRunResult | null> {
		const outcome = parseStageOutcome(runtimeMode, resultText)
		if (!outcome) {
			return null
		}

		const context = await task.getTaskContext()
		const state = await this.stateResolver.resolve(context)

		return this.applyDecision(task, context, state, this.controller.transition(state, outcome, options))
	}

	/**
	 * Resume a task stopped at `BLOCKED` after the Unblock Condition is confirmed.
	 *
	 * Harness-owned like `run`: the caller (a user action or a verified external
	 * event) asserts `unblockConditionMet`, the controller decides, and the runner
	 * applies the decision. Returns `null` when the resume is not routable, so the
	 * caller falls back to its existing resume path instead of writing state.
	 */
	async resume(task: LifecycleTask, unblockConditionMet: boolean): Promise<ModeRunResult | null> {
		const context = await task.getTaskContext()
		const state = await this.stateResolver.resolve(context)

		return this.applyDecision(task, context, state, this.controller.resume(state, unblockConditionMet))
	}

	/**
	 * Approve the plan of a task stopped at `PLAN_READY` (harness-owned).
	 *
	 * Mirrors `resume`: the caller has already obtained the user's approval — the
	 * explicit signal the lifecycle contract requires — and the controller decides
	 * whether the state is actually approvable. Returns `null` when the approval is
	 * not routable (the task is not at `PLAN_READY`), so the caller leaves the task
	 * unchanged instead of writing state.
	 */
	async approvePlan(task: LifecycleTask): Promise<ModeRunResult | null> {
		const context = await task.getTaskContext()
		const state = await this.stateResolver.resolve(context)

		return this.applyDecision(task, context, state, this.controller.approvePlan(state))
	}

	/**
	 * Advance the lifecycle from the current canonical state without a stage
	 * outcome.
	 *
	 * Where `run` reacts to a stage that just reported its result, `continue`
	 * reacts to a state that is already routable (for example `ANALYSIS` with a
	 * complete plan after the Architect stage, or `IMPLEMENTATION` once a unit is
	 * done). It resolves the same three inputs the resolver expects — the canonical
	 * state, the `implementation/` snapshot, and its structural validation report —
	 * all from one filesystem moment so they cannot describe different DAGs.
	 *
	 * Returns `null` when the lifecycle may not advance (the resolver rejected the
	 * state, no ready unit exists, or the state is terminal), so the caller keeps
	 * whatever path it had instead of writing state.
	 */
	async continue(
		task: LifecycleTask,
		options: { requirePlanApproval?: boolean } = {},
	): Promise<ModeRunResult | null> {
		const context = await task.getTaskContext()
		const state = await this.stateResolver.resolve(context)
		const artifacts = await this.parser.read(context)
		const report = await this.validator.validate(context, { status: state.status }, artifacts)

		return this.applyDecision(
			task,
			context,
			state,
			this.controller.resolve({
				state,
				artifacts,
				report,
				requirePlanApproval: options.requirePlanApproval,
			}),
		)
	}

	/**
	 * Apply a resolved decision through `ModeRunner`.
	 *
	 * Both "nothing to do" outcomes — an `invalid` decision and an `invalid` run
	 * result — collapse into `null`, the single fall-back signal the callers act on.
	 */
	private async applyDecision(
		task: LifecycleTask,
		context: TaskContext,
		state: TaskState,
		decision: LifecycleResult,
	): Promise<ModeRunResult | null> {
		if (decision.type === "invalid") {
			return null
		}

		const logger = harnessLogger(this.logger)
		const run = () => this.modeRunner.run(context, state, decision)
		const logContext = await this.harnessLogContext(task)
		const result = logContext ? await logger.runWithContext(logContext, run) : await run()

		return result.type === "invalid" ? null : result
	}

	/**
	 * The task's harness log identity, or `null` when the task double does not
	 * expose one. A failure to resolve it is non-fatal: the lifecycle still runs,
	 * only the mutation record falls back to the ambient/unbound identity.
	 */
	private async harnessLogContext(task: LifecycleTask): Promise<HarnessLogContextInput | null> {
		if (!task.getHarnessLogContext) {
			return null
		}

		try {
			return await task.getHarnessLogContext()
		} catch {
			return null
		}
	}
}
