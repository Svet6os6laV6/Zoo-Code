import {
	HarnessLogger,
	getRootHarnessLogger,
	harnessLogger,
	resetRootHarnessLogger,
	setRootHarnessLogger,
} from "../harness-logger.js"
import { REDACTED } from "../redaction.js"
import type { HarnessLogRecord, HarnessLogSink } from "../types.js"

const FIXED_TIME = "2026-01-01T00:00:00.000Z"
const clock = () => new Date(FIXED_TIME)

function recordingSink(): HarnessLogSink & { records: HarnessLogRecord[] } {
	const records: HarnessLogRecord[] = []

	return {
		name: "recording",
		records,
		write: (record) => {
			records.push(record)
		},
	}
}

describe("HarnessLogger", () => {
	afterEach(() => {
		resetRootHarnessLogger()
	})

	it("records an event with the resolved context", () => {
		const sink = recordingSink()
		const logger = new HarnessLogger({ sinks: [sink], clock, context: { sessionId: "session-1", mode: "code" } })

		logger.event("harness.test", { attributes: { phase: "start" } })

		expect(sink.records).toHaveLength(1)
		expect(sink.records[0]).toEqual({
			kind: "event",
			name: "harness.test",
			level: "info",
			timestamp: FIXED_TIME,
			context: {
				traceId: "unbound-trace",
				sessionId: "session-1",
				taskId: null,
				txxId: null,
				mode: "code",
			},
			attributes: { phase: "start" },
		})
	})

	it("resolves context from ambient, bound, and per-call sources in that precedence order", () => {
		const sink = recordingSink()
		const logger = new HarnessLogger({ sinks: [sink], clock, context: { sessionId: "session-1" } })

		logger.runWithContext({ traceId: "trace-1", taskId: "SITESUP-1116", txxId: "T02" }, () => {
			logger.event("harness.ambient")
			logger.event("harness.override", { context: { taskId: "SITESUP-9999" } })
		})

		logger.event("harness.after")

		expect(sink.records[0]?.context).toEqual({
			traceId: "trace-1",
			sessionId: "session-1",
			taskId: "SITESUP-1116",
			txxId: "T02",
			mode: null,
		})
		expect(sink.records[1]?.context.taskId).toBe("SITESUP-9999")
		// The ambient context must not leak past the scoped call.
		expect(sink.records[2]?.context.traceId).toBe("unbound-trace")
		expect(sink.records[2]?.context.taskId).toBeNull()
	})

	it("binds child context and shares sinks and counters with the parent", () => {
		const sink = recordingSink()
		const logger = new HarnessLogger({ sinks: [sink], clock, context: { sessionId: "session-1" } })
		const child = logger.child({ taskId: "SITESUP-1116", txxId: "T02" })

		child.event("harness.child")

		expect(sink.records[0]?.context).toMatchObject({
			sessionId: "session-1",
			taskId: "SITESUP-1116",
			txxId: "T02",
		})
		expect(logger.counters.emitted).toBe(1)
	})

	it("records a decision with input, result, and reason", () => {
		const sink = recordingSink()
		const logger = new HarnessLogger({ sinks: [sink], clock })

		logger.decision("harness.task.resolve", {
			input: { branch: "feature/SITESUP-1116-heartbeat" },
			result: { taskId: "SITESUP-1116" },
			reason: "task ID extracted from the current Git branch",
			attributes: { reasonCode: "resolved" },
		})

		expect(sink.records[0]).toMatchObject({
			kind: "decision",
			name: "harness.task.resolve",
			input: { branch: "feature/SITESUP-1116-heartbeat" },
			result: { taskId: "SITESUP-1116" },
			reason: "task ID extracted from the current Git branch",
			attributes: { reasonCode: "resolved" },
		})
	})

	it("records a mutation with stateBefore and stateAfter", () => {
		const sink = recordingSink()
		const logger = new HarnessLogger({ sinks: [sink], clock })

		logger.mutation("harness.scheduler.assignNext", {
			target: "/workspace/.roo/tasks/SITESUP-1116/README.md",
			stateBefore: { status: "READY_FOR_IMPLEMENTATION", currentTask: "NONE" },
			stateAfter: { status: "IMPLEMENTATION", currentTask: "implementation/T02-worker.md" },
			reason: "wrote the canonical assignment for T02 into the task README",
		})

		expect(sink.records[0]).toMatchObject({
			kind: "mutation",
			target: "/workspace/.roo/tasks/SITESUP-1116/README.md",
			stateBefore: { status: "READY_FOR_IMPLEMENTATION", currentTask: "NONE" },
			stateAfter: { status: "IMPLEMENTATION", currentTask: "implementation/T02-worker.md" },
		})
	})

	it("records a completed span with duration and status", async () => {
		const sink = recordingSink()
		const logger = new HarnessLogger({ sinks: [sink], clock })

		const result = await logger.span("harness.txx.parse", async (span) => {
			span.annotate({ taskCount: 3 })
			return "parsed"
		})

		expect(result).toBe("parsed")
		expect(sink.records[0]).toMatchObject({
			kind: "span",
			name: "harness.txx.parse",
			status: "ok",
			level: "info",
			attributes: { taskCount: 3 },
		})
		expect(typeof sink.records[0]?.durationMs).toBe("number")
	})

	it("records a failed span and rethrows the original error", async () => {
		const sink = recordingSink()
		const logger = new HarnessLogger({ sinks: [sink], clock })
		const failure = new Error("parse failed")

		await expect(
			logger.span("harness.txx.parse", async () => {
				throw failure
			}),
		).rejects.toBe(failure)

		expect(sink.records[0]).toMatchObject({
			kind: "span",
			status: "error",
			level: "error",
			error: { name: "Error", message: "parse failed" },
		})
	})

	it("isolates synchronous and asynchronous sink failures", async () => {
		const errors: unknown[] = []
		const throwing: HarnessLogSink = {
			name: "throwing",
			write: () => {
				throw new Error("sync sink failure")
			},
		}
		const rejecting: HarnessLogSink = {
			name: "rejecting",
			write: async () => {
				throw new Error("async sink failure")
			},
		}
		const logger = new HarnessLogger({
			sinks: [throwing, rejecting],
			clock,
			onSinkError: (error) => errors.push(error),
		})

		expect(() => logger.event("harness.test")).not.toThrow()
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(logger.counters.dropped).toBe(2)
		expect(errors).toHaveLength(2)
	})

	it("does not propagate a failure of the sink error reporter", () => {
		const logger = new HarnessLogger({
			sinks: [
				{
					name: "throwing",
					write: () => {
						throw new Error("sink failure")
					},
				},
			],
			clock,
			onSinkError: () => {
				throw new Error("reporter failure")
			},
		})

		expect(() => logger.event("harness.test")).not.toThrow()
		expect(logger.counters.dropped).toBe(1)
	})

	it("drops records below the configured minimum level", () => {
		const sink = recordingSink()
		const logger = new HarnessLogger({ sinks: [sink], clock, minLevel: "warn" })

		logger.event("harness.debug", { level: "debug" })
		logger.event("harness.info", { level: "info" })
		logger.event("harness.warn", { level: "warn" })

		expect(sink.records.map((record) => record.name)).toEqual(["harness.warn"])
	})

	it("is a no-op without sinks", () => {
		const logger = new HarnessLogger({ clock })

		logger.event("harness.test")
		logger.decision("harness.test", { input: {}, result: null, reason: "none" })

		expect(logger.counters).toEqual({ emitted: 0, dropped: 0 })
	})

	it("redacts payloads when redactPayloads is enabled", () => {
		const sink = recordingSink()
		const logger = new HarnessLogger({ sinks: [sink], clock, redactPayloads: true })

		logger.decision("harness.test", {
			input: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz" },
			result: { ok: true },
			reason: "checked",
		})

		expect(sink.records[0]?.input).toEqual({ apiKey: REDACTED })
		expect(sink.records[0]?.result).toEqual({ ok: true })
	})

	it("flushes every sink", async () => {
		const flushed: string[] = []
		const logger = new HarnessLogger({
			sinks: [
				{ name: "a", write: () => {}, flush: async () => void flushed.push("a") },
				{ name: "b", write: () => {}, flush: async () => void flushed.push("b") },
			],
			clock,
		})

		await logger.flush()

		expect(flushed).toEqual(["a", "b"])
	})
})

describe("root harness logger", () => {
	afterEach(() => {
		resetRootHarnessLogger()
	})

	it("defaults to a no-op logger and can be replaced at activation time", () => {
		const sink = recordingSink()
		const configured = new HarnessLogger({ sinks: [sink], clock, context: { sessionId: "session-1" } })

		expect(getRootHarnessLogger()).not.toBe(configured)

		setRootHarnessLogger(configured)
		expect(getRootHarnessLogger()).toBe(configured)

		harnessLogger().event("harness.test")
		expect(sink.records).toHaveLength(1)

		resetRootHarnessLogger()
		expect(getRootHarnessLogger()).not.toBe(configured)
	})

	it("prefers an explicitly injected logger over the root logger", () => {
		const explicit = new HarnessLogger({ clock })

		expect(harnessLogger(explicit)).toBe(explicit)
	})
})
