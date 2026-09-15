/**
 * Harness Observability
 *
 * Centralized structured logging for the programmatic harness: one logger,
 * explicit sinks, and a diagnostic reconciler between runtime and canonical
 * state. Platform-agnostic — the host injects sinks.
 */

export {
	HARNESS_LOG_LEVELS,
	HARNESS_LOG_LEVEL_RANK,
	type HarnessDecisionOptions,
	type HarnessEventOptions,
	type HarnessLogContext,
	type HarnessLogContextInput,
	type HarnessLogError,
	type HarnessLogLevel,
	type HarnessLogRecord,
	type HarnessLogRecordKind,
	type HarnessLogSink,
	type HarnessLoggerOptions,
	type HarnessLoggerPort,
	type HarnessLoggerStats,
	type HarnessMutationOptions,
	type HarnessSpanHandle,
	type HarnessSpanOptions,
	type HarnessSpanStatus,
} from "./types.js"

export {
	HarnessLogger,
	NOOP_HARNESS_LOGGER,
	getRootHarnessLogger,
	harnessLogger,
	resetRootHarnessLogger,
	setRootHarnessLogger,
} from "./harness-logger.js"

export { OutputChannelSink, type HarnessOutputChannel, type OutputChannelSinkOptions } from "./output-channel-sink.js"

export {
	JsonlSink,
	DEFAULT_JSONL_MAX_ARCHIVES,
	DEFAULT_JSONL_MAX_BYTES,
	type JsonlSinkFileSystem,
	type JsonlSinkOptions,
} from "./jsonl-sink.js"

export {
	REDACTED,
	isSensitiveKey,
	redactPrompt,
	redactRecord,
	redactText,
	redactValue,
	type RedactOptions,
} from "./redaction.js"

export {
	StateReconciler,
	diffTaskState,
	type StateDifference,
	type StateReconcileOptions,
	type StateReconciliation,
	type StateReconcilerFileSystem,
} from "./state-reconciler.js"
