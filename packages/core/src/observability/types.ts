/**
 * Harness observability contracts.
 *
 * The programmatic harness makes decisions (resolve the task identity, resolve
 * the lifecycle state, parse the DAG, validate artifacts, assign the next
 * implementation unit) and mutations (rewrite the canonical README). This module
 * defines the structured records used to make those decisions and mutations
 * reviewable after the fact.
 *
 * Nothing here imports VSCode: sinks are injected by the host, so the same
 * contracts work in the extension, the CLI, and unit tests.
 */

export const HARNESS_LOG_LEVELS = ["debug", "info", "warn", "error"] as const

export type HarnessLogLevel = (typeof HARNESS_LOG_LEVELS)[number]

export const HARNESS_LOG_LEVEL_RANK: Readonly<Record<HarnessLogLevel, number>> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
}

/**
 * Correlation identity of a harness record.
 *
 * Two independent axes are kept apart on purpose:
 *
 * - `traceId` is the durable lifecycle of one harness task. It is generated once
 *   per task run (when the task identity is first resolved) and never changes, so
 *   a single filter reconstructs `Architect -> Code T01 -> DONE -> T02 -> ...`.
 * - `spanId` is the one operation currently in flight (`parser.read`,
 *   `scheduler.assignNext`, one prompt assembly, one LLM request). It is bound by
 *   `HarnessLogger.span()` for the span body and generated per record otherwise.
 *
 * `taskId` is the durable harness task (for example `SITESUP-1116`) and is
 * deliberately *not* the internal agent task UUID; that one lives in
 * `agentTaskId` (for example `01a0a924-...`) so harness records are never keyed
 * by an opaque per-instance id. `txxId` is the implementation unit in play
 * (for example `T02`) and `mode` the mode slug that produced the decision.
 */
export type HarnessLogContext = {
	readonly traceId: string
	readonly spanId: string | null
	readonly sessionId: string
	readonly taskId: string | null
	readonly agentTaskId: string | null
	readonly txxId: string | null
	readonly mode: string | null
}

/** Partial context used to bind a child logger or a single record. */
export type HarnessLogContextInput = Partial<HarnessLogContext>

export type HarnessLogRecordKind = "event" | "span" | "decision" | "mutation"

export type HarnessSpanStatus = "ok" | "error"

export type HarnessLogError = {
	readonly name: string
	readonly message: string
	readonly stack?: string
	readonly code?: string
}

/**
 * One structured record.
 *
 * The shape is flat on purpose: a JSONL sink writes one line per record and a
 * reader must be able to filter on `name`, `kind`, and `context.taskId` without
 * understanding the domain.
 */
export type HarnessLogRecord = {
	readonly kind: HarnessLogRecordKind
	readonly name: string
	readonly level: HarnessLogLevel
	/** ISO-8601 timestamp of when the record was completed. */
	readonly timestamp: string
	readonly context: HarnessLogContext
	/** Present for spans only. */
	readonly durationMs?: number
	/** Present for spans only. */
	readonly status?: HarnessSpanStatus
	/** Decisions: the observed input the decision was derived from. */
	readonly input?: unknown
	/** Decisions: the outcome, including `null`/negative outcomes. */
	readonly result?: unknown
	/** Decisions and mutations: why this outcome and not another. */
	readonly reason?: string
	/** Mutations: the artifact state before the write. */
	readonly stateBefore?: unknown
	/** Mutations: the artifact state after the write. */
	readonly stateAfter?: unknown
	/** Mutations: what was written (path, fields). */
	readonly target?: string
	readonly attributes?: Readonly<Record<string, unknown>>
	readonly error?: HarnessLogError
}

/**
 * A log destination. Implementations must tolerate being called from any layer
 * and must never reject in a way that reaches the harness: the logger reports
 * sink failures through `HarnessLoggerOptions.onSinkError` and drops them.
 */
export type HarnessLogSink = {
	readonly name: string
	write(record: HarnessLogRecord): void | Promise<void>
	flush?(): void | Promise<void>
}

export type HarnessEventOptions = {
	readonly level?: HarnessLogLevel
	readonly context?: HarnessLogContextInput
	readonly attributes?: Readonly<Record<string, unknown>>
}

export type HarnessDecisionOptions = {
	/** What the decision was made from (branch name, README fields, DAG state). */
	readonly input: unknown
	/** What was decided. `null` is a meaningful outcome and is recorded as-is. */
	readonly result: unknown
	/** Why this outcome won: a stable reason code plus human-readable context. */
	readonly reason: string
	readonly level?: HarnessLogLevel
	readonly context?: HarnessLogContextInput
	readonly attributes?: Readonly<Record<string, unknown>>
}

export type HarnessMutationOptions = {
	/** What was written, for example `README.md#Status`. */
	readonly target: string
	readonly stateBefore: unknown
	readonly stateAfter: unknown
	readonly reason: string
	readonly level?: HarnessLogLevel
	readonly context?: HarnessLogContextInput
	readonly attributes?: Readonly<Record<string, unknown>>
}

export type HarnessSpanOptions = {
	readonly level?: HarnessLogLevel
	readonly context?: HarnessLogContextInput
	readonly attributes?: Readonly<Record<string, unknown>>
}

/** Handle passed to a span body so it can annotate itself mid-flight. */
export type HarnessSpanHandle = {
	readonly context: HarnessLogContext
	annotate(attributes: Readonly<Record<string, unknown>>): void
}

export type HarnessLoggerStats = {
	emitted: number
	dropped: number
}

export type HarnessLoggerOptions = {
	readonly sinks?: readonly HarnessLogSink[]
	/** Context bound to this logger; merged over the ambient context. */
	readonly context?: HarnessLogContextInput
	/** Records below this level are discarded. */
	readonly minLevel?: HarnessLogLevel
	readonly clock?: () => Date
	/** Applies `redactRecord` to every payload. Off by default (cost + harness payloads are not secret). */
	readonly redactPayloads?: boolean
	/**
	 * Shared counters. Pass the same object to children to aggregate; the root
	 * logger creates one when omitted.
	 */
	readonly stats?: HarnessLoggerStats
	/** Reports sink failures. Never called with a value that reaches the harness. */
	readonly onSinkError?: (error: unknown, sink: HarnessLogSink) => void
}

/**
 * The logger surface the harness depends on.
 *
 * Harness modules hold `HarnessLoggerPort`, never the concrete class, so tests
 * can pass a recording double and the extension can pass a session-bound logger.
 */
export interface HarnessLoggerPort {
	readonly context: HarnessLogContext
	/** Derives a logger with additional bound context. */
	child(context: HarnessLogContextInput): HarnessLoggerPort
	event(name: string, options?: HarnessEventOptions): void
	decision(name: string, options: HarnessDecisionOptions): void
	mutation(name: string, options: HarnessMutationOptions): void
	span<T>(name: string, run: (span: HarnessSpanHandle) => Promise<T> | T, options?: HarnessSpanOptions): Promise<T>
	/**
	 * Runs `run` with an ambient context that every logger in the process sees
	 * for the duration of the call. Used to bind the per-turn `traceId` without
	 * threading it through every harness signature.
	 */
	runWithContext<T>(context: HarnessLogContextInput, run: () => T): T
	flush(): Promise<void>
}
