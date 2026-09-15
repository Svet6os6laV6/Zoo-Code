import type {
	HarnessDecisionOptions,
	HarnessEventOptions,
	HarnessLogContext,
	HarnessLogContextInput,
	HarnessLogRecord,
	HarnessLogRecordKind,
	HarnessLoggerPort,
	HarnessMutationOptions,
	HarnessSpanOptions,
} from "../../types.js"

const BASE_CONTEXT: HarnessLogContext = {
	traceId: "trace-test",
	sessionId: "session-test",
	taskId: null,
	txxId: null,
	mode: null,
}

const FIXED_TIMESTAMP = "1970-01-01T00:00:00.000Z"

/**
 * Recording double for `HarnessLoggerPort`.
 *
 * Harness modules accept an injected logger, so instrumentation tests assert on
 * the records a component emits without touching sinks or the process-wide root
 * logger. Children share the parent's record array.
 */
export class RecordingHarnessLogger implements HarnessLoggerPort {
	readonly records: HarnessLogRecord[]

	private readonly bound: HarnessLogContextInput

	constructor(bound: HarnessLogContextInput = {}, records: HarnessLogRecord[] = []) {
		this.bound = bound
		this.records = records
	}

	get context(): HarnessLogContext {
		return { ...BASE_CONTEXT, ...this.bound }
	}

	child(context: HarnessLogContextInput): HarnessLoggerPort {
		return new RecordingHarnessLogger({ ...this.bound, ...context }, this.records)
	}

	event(name: string, options: HarnessEventOptions = {}): void {
		this.push({
			kind: "event",
			name,
			level: options.level ?? "info",
			timestamp: FIXED_TIMESTAMP,
			context: this.context,
			...(options.attributes ? { attributes: options.attributes } : {}),
		})
	}

	decision(name: string, options: HarnessDecisionOptions): void {
		this.push({
			kind: "decision",
			name,
			level: options.level ?? "info",
			timestamp: FIXED_TIMESTAMP,
			context: this.context,
			input: options.input,
			result: options.result,
			reason: options.reason,
			...(options.attributes ? { attributes: options.attributes } : {}),
		})
	}

	mutation(name: string, options: HarnessMutationOptions): void {
		this.push({
			kind: "mutation",
			name,
			level: options.level ?? "info",
			timestamp: FIXED_TIMESTAMP,
			context: this.context,
			target: options.target,
			stateBefore: options.stateBefore,
			stateAfter: options.stateAfter,
			reason: options.reason,
			...(options.attributes ? { attributes: options.attributes } : {}),
		})
	}

	async span<T>(
		name: string,
		run: (span: {
			context: HarnessLogContext
			annotate: (attributes: Record<string, unknown>) => void
		}) => Promise<T> | T,
		options: HarnessSpanOptions = {},
	): Promise<T> {
		const attributes: Record<string, unknown> = { ...(options.attributes ?? {}) }
		const startedAt = Date.now()

		try {
			const result = await run({ context: this.context, annotate: (extra) => Object.assign(attributes, extra) })
			this.push({
				kind: "span",
				name,
				level: options.level ?? "info",
				timestamp: FIXED_TIMESTAMP,
				context: this.context,
				durationMs: Date.now() - startedAt,
				status: "ok",
				...(Object.keys(attributes).length > 0 ? { attributes } : {}),
			})
			return result
		} catch (error) {
			this.push({
				kind: "span",
				name,
				level: options.level ?? "error",
				timestamp: FIXED_TIMESTAMP,
				context: this.context,
				durationMs: Date.now() - startedAt,
				status: "error",
				...(Object.keys(attributes).length > 0 ? { attributes } : {}),
			})
			throw error
		}
	}

	runWithContext<T>(_context: HarnessLogContextInput, run: () => T): T {
		return run()
	}

	async flush(): Promise<void> {}

	byName(name: string): HarnessLogRecord[] {
		return this.records.filter((record) => record.name === name)
	}

	byKind(kind: HarnessLogRecordKind): HarnessLogRecord[] {
		return this.records.filter((record) => record.kind === kind)
	}

	clear(): void {
		this.records.length = 0
	}

	private push(record: HarnessLogRecord): void {
		this.records.push(record)
	}
}
