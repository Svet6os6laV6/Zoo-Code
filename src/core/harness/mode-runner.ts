import {
	LifecycleController,
	ModeRunner,
	TaskStateResolver,
	parseStageOutcome,
	type LifecycleMode,
	type ModeRunResult,
	type TaskContext,
} from "@roo-code/core"

type LifecycleTask = {
	getTaskContext(): Promise<TaskContext>
}

type HarnessModeRunnerDependencies = {
	readonly stateResolver?: Pick<TaskStateResolver, "resolve">
	readonly controller?: Pick<LifecycleController, "transition" | "resume">
	readonly modeRunner?: Pick<ModeRunner, "run">
}

export class HarnessModeRunner {
	private readonly stateResolver: Pick<TaskStateResolver, "resolve">
	private readonly controller: Pick<LifecycleController, "transition" | "resume">
	private readonly modeRunner: Pick<ModeRunner, "run">

	constructor(
		startMode: (mode: LifecycleMode, message: string) => Promise<void>,
		dependencies: HarnessModeRunnerDependencies = {},
	) {
		this.stateResolver = dependencies.stateResolver ?? new TaskStateResolver()
		this.controller = dependencies.controller ?? new LifecycleController()
		this.modeRunner = dependencies.modeRunner ?? new ModeRunner(startMode)
	}

	async run(task: LifecycleTask, runtimeMode: string, resultText: string): Promise<ModeRunResult | null> {
		const outcome = parseStageOutcome(runtimeMode, resultText)
		if (!outcome) {
			return null
		}

		const context = await task.getTaskContext()
		const state = await this.stateResolver.resolve(context)
		const decision = this.controller.transition(state, outcome)
		if (decision.type === "invalid") {
			return null
		}

		const result = await this.modeRunner.run(context, state, decision)
		return result.type === "invalid" ? null : result
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
		const decision = this.controller.resume(state, unblockConditionMet)
		if (decision.type === "invalid") {
			return null
		}

		const result = await this.modeRunner.run(context, state, decision)
		return result.type === "invalid" ? null : result
	}
}
