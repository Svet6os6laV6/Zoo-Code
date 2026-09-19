/**
 * HarnessLogger
 *
 * Central structured logger for the programmatic harness.
 *
 * Design constraints:
 * - Logging must never change harness behavior. Sink failures are counted and
 *   reported through `onSinkError`, never thrown into the caller.
 * - The default logger has no sinks, so an uninstrumented process pays only a
 *   length check per call.
 * - Context is resolved from three sources, in increasing precedence: the
 *   ambient context (`runWithContext`), the logger's bound context (`child`),
 *   and per-call overrides. The ambient context exists so a lifecycle `traceId`
 *   reaches harness internals without threading it through every signature.
 * - `traceId` identifies the whole task lifecycle; `spanId` identifies one
 *   operation. `span()` binds a fresh `spanId` to its body so every record
 *   emitted while an operation runs carries the same operation id, and `emit()`
 *   mints one for records emitted outside any span. A trace therefore reads as
 *   one lifecycle ordered into operations instead of one trace per turn.
 */

import { AsyncLocalStorage } from "async_hooks"
import { randomUUID } from "crypto"

import { redactRecord } from "./redaction.js"
import {
	HARNESS_LOG_LEVEL_RANK,
	type HarnessDecisionOptions,
	type HarnessEventOptions,
	type HarnessLogContext,
	type HarnessLogContextInput,
	type HarnessLogError,
	type HarnessLogLevel,
	type HarnessLogRecord,
	type HarnessLogSink,
	type HarnessLoggerOptions,
	type HarnessLoggerPort,
	type HarnessLoggerStats,
	type HarnessMutationOptions,
	type HarnessSpanHandle,
	type HarnessSpanOptions,
} from "./types.js"

/**
 * Last-resort values for records emitted before a lifecycle is bound.
 *
 * `unbound-trace` is a diagnostic marker: a record carrying it was written
 * outside any `runWithContext`, so its trace cannot be reconstructed. Callers
 * that own a task must bind `traceId` explicitly instead of relying on this.
 */
const DEFAULT_CONTEXT: HarnessLogContext = {
	traceId: "unbound-trace",
	spanId: null,
	sessionId: "unbound-session",
	taskId: null,
	agentTaskId: null,
	txxId: null,
	mode: null,
}

/**
 * Process-wide ambient context. A single store is intentional: the harness
 * resolves a task in one async flow, and every logger in that flow (including
 * the module-level root logger used by the harness classes) must observe the
 * same turn identity.
 */
const ambientContext = new AsyncLocalStorage<HarnessLogContextInput>()

type MutableContext = {
	traceId: string
	spanId: string | null
	sessionId: string
	taskId: string | null
	agentTaskId: string | null
	txxId: string | null
	mode: string | null
}

function mergeContext(...parts: readonly (HarnessLogContextInput | undefined)[]): HarnessLogContext {
	const merged: MutableContext = { ...DEFAULT_CONTEXT }

	for (const part of parts) {
		if (!part) {
			continue
		}
		if (part.traceId !== undefined) {
			merged.traceId = part.traceId
		}
		if (part.spanId !== undefined) {
			merged.spanId = part.spanId
		}
		if (part.sessionId !== undefined) {
			merged.sessionId = part.sessionId
		}
		if (part.taskId !== undefined) {
			merged.taskId = part.taskId
		}
		if (part.agentTaskId !== undefined) {
			merged.agentTaskId = part.agentTaskId
		}
		if (part.txxId !== undefined) {
			merged.txxId = part.txxId
		}
		if (part.mode !== undefined) {
			merged.mode = part.mode
		}
	}

	return merged
}

function toHarnessError(error: unknown): HarnessLogError {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "string" ? error.code : undefined
		return {
			name: error.name,
			message: error.message,
			...(error.stack ? { stack: error.stack } : {}),
			...(code ? { code } : {}),
		}
	}

	return {
		name: "NonError",
		message: typeof error === "string" ? error : safeStringify(error),
	}
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value)
	} catch {
		return String(value)
	}
}

export class HarnessLogger implements HarnessLoggerPort {
	private readonly options: HarnessLoggerOptions
	private readonly sinks: readonly HarnessLogSink[]
	private readonly minLevelRank: number
	private readonly clock: () => Date
	private readonly redactPayloads: boolean
	private readonly stats: HarnessLoggerStats
	private readonly boundContext: HarnessLogContextInput

	constructor(options: HarnessLoggerOptions = {}) {
		this.options = options
		this.sinks = options.sinks ?? []
		this.minLevelRank = HARNESS_LOG_LEVEL_RANK[options.minLevel ?? "debug"]
		this.clock = options.clock ?? (() => new Date())
		this.redactPayloads = options.redactPayloads ?? false
		this.stats = options.stats ?? { emitted: 0, dropped: 0 }
		this.boundContext = options.context ?? {}
	}

	get context(): HarnessLogContext {
		return this.resolveContext()
	}

	get counters(): HarnessLoggerStats {
		return { ...this.stats }
	}

	child(context: HarnessLogContextInput): HarnessLoggerPort {
		return new HarnessLogger({
			...this.options,
			context: mergeContext(this.boundContext, context),
			stats: this.stats,
		})
	}

	event(name: string, options: HarnessEventOptions = {}): void {
		this.emit({
			kind: "event",
			name,
			level: options.level ?? "info",
			timestamp: this.timestamp(),
			context: this.resolveContext(options.context),
			...(options.attributes ? { attributes: options.attributes } : {}),
		})
	}

	decision(name: string, options: HarnessDecisionOptions): void {
		this.emit({
			kind: "decision",
			name,
			level: options.level ?? "info",
			timestamp: this.timestamp(),
			context: this.resolveContext(options.context),
			input: options.input,
			result: options.result,
			reason: options.reason,
			...(options.attributes ? { attributes: options.attributes } : {}),
		})
	}

	mutation(name: string, options: HarnessMutationOptions): void {
		this.emit({
			kind: "mutation",
			name,
			level: options.level ?? "info",
			timestamp: this.timestamp(),
			context: this.resolveContext(options.context),
			target: options.target,
			stateBefore: options.stateBefore,
			stateAfter: options.stateAfter,
			reason: options.reason,
			...(options.attributes ? { attributes: options.attributes } : {}),
		})
	}

	async span<T>(
		name: string,
		run: (span: HarnessSpanHandle) => Promise<T> | T,
		options: HarnessSpanOptions = {},
	): Promise<T> {
		const startedAt = this.clock().getTime()
		const attributes: Record<string, unknown> = { ...(options.attributes ?? {}) }
		// One span id per operation: bound to the body so every nested record
		// shares it, and reused for the span record itself.
		const spanContext: HarnessLogContextInput = { ...(options.context ?? {}), spanId: randomUUID() }
		const context = this.resolveContext(spanContext)
		const handle: HarnessSpanHandle = {
			context,
			annotate: (extra) => {
				Object.assign(attributes, extra)
			},
		}

		const complete = (status: "ok" | "error", error?: unknown): void => {
			this.emit({
				kind: "span",
				name,
				level: options.level ?? (status === "error" ? "error" : "info"),
				timestamp: this.timestamp(),
				context: this.resolveContext(spanContext),
				durationMs: Math.max(0, this.clock().getTime() - startedAt),
				status,
				...(Object.keys(attributes).length > 0 ? { attributes } : {}),
				...(error === undefined ? {} : { error: toHarnessError(error) }),
			})
		}

		try {
			const result = await ambientContext.run(mergeContext(ambientContext.getStore(), spanContext), () =>
				run(handle),
			)
			complete("ok")
			return result
		} catch (error) {
			complete("error", error)
			throw error
		}
	}

	runWithContext<T>(context: HarnessLogContextInput, run: () => T): T {
		const merged = mergeContext(ambientContext.getStore(), context)
		return ambientContext.run(merged, run)
	}

	async flush(): Promise<void> {
		await Promise.all(
			this.sinks.map(async (sink) => {
				try {
					await sink.flush?.()
				} catch (error) {
					this.handleSinkError(error, sink)
				}
			}),
		)
	}

	private timestamp(): string {
		return this.clock().toISOString()
	}

	private resolveContext(overrides?: HarnessLogContextInput): HarnessLogContext {
		return mergeContext(ambientContext.getStore(), this.boundContext, overrides)
	}

	private emit(record: HarnessLogRecord): void {
		if (this.sinks.length === 0) {
			return
		}
		if (HARNESS_LOG_LEVEL_RANK[record.level] < this.minLevelRank) {
			return
		}

		// Every record is one operation, so every record gets a span id: the one
		// bound by the enclosing span, or a fresh one for a top-level record.
		const identified: HarnessLogRecord = record.context.spanId
			? record
			: { ...record, context: { ...record.context, spanId: randomUUID() } }

		let payload = identified
		if (this.redactPayloads) {
			try {
				payload = redactRecord(identified)
			} catch {
				// A payload the redactor cannot walk is still worth logging unredacted
				// only if it is not a prompt; the prompt path redacts explicitly.
				payload = identified
			}
		}

		this.stats.emitted += 1

		for (const sink of this.sinks) {
			try {
				const result = sink.write(payload)
				if (result && typeof result.then === "function") {
					void result.catch((error: unknown) => this.handleSinkError(error, sink))
				}
			} catch (error) {
				this.handleSinkError(error, sink)
			}
		}
	}

	private handleSinkError(error: unknown, sink: HarnessLogSink): void {
		this.stats.dropped += 1
		try {
			this.options.onSinkError?.(error, sink)
		} catch {
			// Reporting a sink failure must not become a new failure.
		}
	}
}

/**
 * The process-wide root logger.
 *
 * Harness classes resolve this lazily (at call time, not import time) so the
 * extension can configure sinks during activation and every harness module
 * picks them up without constructor plumbing.
 */
let rootLogger: HarnessLoggerPort = new HarnessLogger()

export function getRootHarnessLogger(): HarnessLoggerPort {
	return rootLogger
}

export function setRootHarnessLogger(logger: HarnessLoggerPort): void {
	rootLogger = logger
}

/** Restores the no-op root logger. Intended for tests. */
export function resetRootHarnessLogger(): void {
	rootLogger = new HarnessLogger()
}

/** A logger with no sinks: every call is a no-op. */
export const NOOP_HARNESS_LOGGER: HarnessLoggerPort = new HarnessLogger()

/**
 * Resolves the logger a harness module should use: the explicitly injected one
 * when present (tests, per-task binding), otherwise the process-wide root.
 *
 * Resolution happens at call time, so a harness class constructed before
 * activation still observes sinks configured later.
 */
export function harnessLogger(explicit?: HarnessLoggerPort): HarnessLoggerPort {
	return explicit ?? rootLogger
}

export type { HarnessLogLevel }
