import { OutputChannelSink } from "../output-channel-sink.js"
import type { HarnessLogRecord } from "../types.js"

function channel(): { lines: string[]; appendLine: (value: string) => void } {
	const lines: string[] = []

	return {
		lines,
		appendLine: (value) => {
			lines.push(value)
		},
	}
}

function record(overrides: Partial<HarnessLogRecord> = {}): HarnessLogRecord {
	return {
		kind: "decision",
		name: "harness.scheduler.assignNext",
		level: "info",
		timestamp: "2026-01-01T00:00:00.000Z",
		context: {
			traceId: "trace-1",
			sessionId: "session-1",
			taskId: "SITESUP-1116",
			txxId: "T02",
			mode: "code",
		},
		reason: "assigned the lowest-numbered ready implementation unit T02",
		...overrides,
	}
}

describe("OutputChannelSink", () => {
	it("writes a human-readable summary line", () => {
		const output = channel()
		const sink = new OutputChannelSink({ channel: output })

		sink.write(record({ status: "ok", durationMs: 12 }))

		expect(output.lines).toHaveLength(1)
		expect(output.lines[0]).toContain("decision harness.scheduler.assignNext")
		expect(output.lines[0]).toContain("trace=trace-1")
		expect(output.lines[0]).toContain("task=SITESUP-1116")
		expect(output.lines[0]).toContain("txx=T02")
		expect(output.lines[0]).toContain("mode=code")
		expect(output.lines[0]).toContain("status=ok")
		expect(output.lines[0]).toContain("durationMs=12")
		expect(output.lines[0]).toContain("reason=assigned the lowest-numbered ready implementation unit T02")
	})

	it("includes the error summary for failed spans", () => {
		const output = channel()
		const sink = new OutputChannelSink({ channel: output })

		sink.write(
			record({
				kind: "span",
				level: "error",
				status: "error",
				error: { name: "TaskStateError", message: "Invalid task status: BROKEN" },
			}),
		)

		expect(output.lines[0]).toContain("[ERROR]")
		expect(output.lines[0]).toContain("error=TaskStateError: Invalid task status: BROKEN")
	})

	it("drops records below the configured minimum level", () => {
		const output = channel()
		const sink = new OutputChannelSink({ channel: output, minLevel: "warn" })

		sink.write(record({ level: "debug" }))
		sink.write(record({ level: "warn" }))

		expect(output.lines).toHaveLength(1)
		expect(output.lines[0]).toContain("[WARN]")
	})

	it("omits payloads by default and appends them when requested", () => {
		const output = channel()
		const sink = new OutputChannelSink({ channel: output, includePayload: true })

		sink.write(record({ input: { status: "READY_FOR_IMPLEMENTATION" }, result: { taskId: "T02" } }))

		expect(output.lines[0]).toContain('"taskId":"T02"')
	})

	it("truncates long lines", () => {
		const output = channel()
		const sink = new OutputChannelSink({ channel: output, maxLineLength: 40 })

		sink.write(record())

		expect(output.lines[0]).toHaveLength(41)
		expect(output.lines[0]?.endsWith("…")).toBe(true)
	})

	it("survives an unserializable payload", () => {
		const output = channel()
		const sink = new OutputChannelSink({ channel: output, includePayload: true })

		sink.write(record({ attributes: { big: 10n } }))

		expect(output.lines[0]).toContain("[unserializable payload]")
	})
})
