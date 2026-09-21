import {
	ArtifactValidator,
	LifecycleController,
	ModeRunner,
	TaskStateResolver,
	TxxParser,
	parseStageOutcome,
	type LifecycleMode,
	type LifecycleResult,
	type ModeRunResult,
	type TaskContext,
	type TaskState,
} from "@roo-code/core"

type LifecycleTask = {
	getTaskContext(): Promise<TaskContext>
}

type HarnessModeRunnerDependencies = {
	readonly stateResolver?: Pick<TaskStateResolver, "resolve">
	readonly controller?: Pick<LifecycleController, "transition" | "resume" | "resolve">
	readonly modeRunner?: Pick<ModeRunner, "run">
	readonly parser?: Pick<TxxParser, "read">
	readonly validator?: Pick<ArtifactValidator, "validate">
}

export class HarnessModeRunner {
	private readonly stateResolver: Pick<TaskStateResolver, "resolve">
	private readonly controller: Pick<LifecycleController, "transition" | "resume" | "resolve">
	private readonly modeRunner: Pick<ModeRunner, "run">
	private readonly parser: Pick<TxxParser, "read">
	private readonly validator: Pick<ArtifactValidator, "validate">

	constructor(
		startMode: (mode: LifecycleMode, message: string) => Promise<void>,
		dependencies: HarnessModeRunnerDependencies = {},
	) {
		this.stateResolver = dependencies.stateResolver ?? new TaskStateResolver()
		this.controller = dependencies.controller ?? new LifecycleController()
		this.modeRunner = dependencies.modeRunner ?? new ModeRunner(startMode)
		this.parser = dependencies.parser ?? new TxxParser()
		this.validator = dependencies.validator ?? new ArtifactValidator()
	}

	async run(task: LifecycleTask, runtimeMode: string, resultText: string): Promise<ModeRunResult | null> {
		const outcome = parseStageOutcome(runtimeMode, resultText)
		if (!outcome) {
			return null
		}

		const context = await task.getTaskContext()
		const state = await this.stateResolver.resolve(context)

		return this.applyDecision(context, state, this.controller.transition(state, outcome))
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

		return this.applyDecision(context, state, this.controller.resume(state, unblockConditionMet))
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
	async continue(task: LifecycleTask): Promise<ModeRunResult | null> {
		const context = await task.getTaskContext()
		const state = await this.stateResolver.resolve(context)
		const artifacts = await this.parser.read(context)
		const report = await this.validator.validate(context, { status: state.status }, artifacts)

		return this.applyDecision(context, state, this.controller.resolve({ state, artifacts, report }))
	}

	/**
	 * Apply a resolved decision through `ModeRunner`.
	 *
	 * Both "nothing to do" outcomes — an `invalid` decision and an `invalid` run
	 * result — collapse into `null`, the single fall-back signal the callers act on.
	 */
	private async applyDecision(
		context: TaskContext,
		state: TaskState,
		decision: LifecycleResult,
	): Promise<ModeRunResult | null> {
		if (decision.type === "invalid") {
			return null
		}

		const result = await this.modeRunner.run(context, state, decision)

		return result.type === "invalid" ? null : result
	}
}
