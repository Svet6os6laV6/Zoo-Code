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
	readonly controller?: Pick<LifecycleController, "transition">
	readonly modeRunner?: Pick<ModeRunner, "run">
}

export class HarnessModeRunner {
	private readonly stateResolver: Pick<TaskStateResolver, "resolve">
	private readonly controller: Pick<LifecycleController, "transition">
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
}
