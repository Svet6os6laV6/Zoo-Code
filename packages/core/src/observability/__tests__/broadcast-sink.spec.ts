import { BroadcastSink, DEFAULT_BROADCAST_CAPACITY } from "../broadcast-sink.js"
import { HarnessLogger } from "../harness-logger.js"
import type { HarnessLogRecord } from "../types.js"

function record(overrides: Partial<HarnessLogRecord> = {}): HarnessLogRecord {
	return {
		kind: "event",
		name: "harness.test",
		level: "info",
		timestamp: "2026-01-01T00:00:00.000Z",
		context: {
			traceId: "trace-1",
			spanId: "span-1",
			sessionId: "session-1",
			taskId: "SITESUP-1112",
			agentTaskId: null,
			txxId: "T01",
			mode: "code",
		},
		...overrides,
	}
}

describe("BroadcastSink", () => {
	it("defaults to the documented capacity", () => {
		expect(DEFAULT_BROADCAST_CAPACITY).toBe(2_000)
	})

	it("keeps at most capacity records, evicting the oldest", () => {
		const sink = new BroadcastSink({ capacity: 3 })

		sink.write(record({ name: "harness.1" }))
		sink.write(record({ name: "harness.2" }))
		sink.write(record({ name: "harness.3" }))
		sink.write(record({ name: "harness.4" }))

		expect(sink.recent().map((entry) => entry.name)).toEqual(["harness.2", "harness.3", "harness.4"])
	})

	it("returns recent() in write order, oldest to newest", () => {
		const sink = new BroadcastSink()

		sink.write(record({ name: "harness.first" }))
		sink.write(record({ name: "harness.second" }))

		expect(sink.recent().map((entry) => entry.name)).toEqual(["harness.first", "harness.second"])
	})

	it("returns a snapshot that later writes do not mutate", () => {
		const sink = new BroadcastSink({ capacity: 2 })

		sink.write(record({ name: "harness.1" }))
		const snapshot = sink.recent()
		sink.write(record({ name: "harness.2" }))
		sink.write(record({ name: "harness.3" }))

		expect(snapshot).toHaveLength(1)
		expect(sink.recent().map((entry) => entry.name)).toEqual(["harness.2", "harness.3"])
	})

	it("delivers records to subscribers and stops after unsubscribe", () => {
		const sink = new BroadcastSink()
		const received: HarnessLogRecord[] = []
		const unsubscribe = sink.subscribe((entry) => {
			received.push(entry)
		})

		sink.write(record({ name: "harness.before" }))
		unsubscribe()
		// A second unsubscribe must be safe.
		unsubscribe()
		sink.write(record({ name: "harness.after" }))

		expect(received.map((entry) => entry.name)).toEqual(["harness.before"])
	})

	it("isolates a throwing listener without breaking delivery or write()", () => {
		const errors: unknown[] = []
		const sink = new BroadcastSink({
			onListenerError: (error) => {
				errors.push(error)
			},
		})
		const received: HarnessLogRecord[] = []

		sink.subscribe(() => {
			throw new Error("listener exploded")
		})
		sink.subscribe((entry) => {
			received.push(entry)
		})

		expect(() => sink.write(record({ name: "harness.survivor" }))).not.toThrow()
		expect(received.map((entry) => entry.name)).toEqual(["harness.survivor"])
		expect(errors).toHaveLength(1)
	})

	it("drops listener errors silently when no onListenerError is configured", () => {
		const sink = new BroadcastSink()

		sink.subscribe(() => {
			throw new Error("listener exploded")
		})

		expect(() => sink.write(record())).not.toThrow()
		expect(sink.recent()).toHaveLength(1)
	})

	it("resolves flush() immediately", async () => {
		const sink = new BroadcastSink()

		await expect(Promise.resolve(sink.flush())).resolves.toBeUndefined()
	})

	it("receives records emitted through HarnessLogger", () => {
		const sink = new BroadcastSink()
		const logger = new HarnessLogger({
			sinks: [sink],
			clock: () => new Date("2026-01-01T00:00:00.000Z"),
			context: { sessionId: "session-1", mode: "code" },
		})
		const received: HarnessLogRecord[] = []
		sink.subscribe((entry) => {
			received.push(entry)
		})

		logger.event("harness.broadcast.test")

		expect(received).toHaveLength(1)
		expect(received[0]).toMatchObject({
			kind: "event",
			name: "harness.broadcast.test",
			level: "info",
			timestamp: "2026-01-01T00:00:00.000Z",
		})
		expect(sink.recent()).toEqual(received)
	})
})
