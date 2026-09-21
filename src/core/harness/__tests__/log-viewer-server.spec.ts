import * as fs from "fs/promises"
import * as http from "http"
import * as os from "os"
import * as path from "path"

import nock from "nock"

import { BroadcastSink, type HarnessLogRecord } from "@roo-code/core"

import { allowNetConnect } from "../../../vitest.setup"

import {
	closeLogViewerServer,
	createLogViewerServer,
	getOrCreateLogViewerServer,
	type LogViewerServer,
	type LogViewerServerOptions,
} from "../log-viewer/server"
import type { HarnessLogSessionSummary, SessionRecordsPage } from "../log-viewer/sessions"

function record(name: string): HarnessLogRecord {
	return {
		kind: "event",
		name,
		level: "info",
		timestamp: new Date().toISOString(),
		context: {
			traceId: "trace-1",
			spanId: null,
			sessionId: "test-session",
			taskId: null,
			agentTaskId: null,
			txxId: null,
			mode: null,
		},
	}
}

type Fixture = {
	logsDirectory: string
	broadcast: BroadcastSink
	server: LogViewerServer
	/** Parsed `server.url`: origin is the loopback base, `token` the auth token. */
	baseUrl: URL
	cleanup(): Promise<void>
}

async function startFixture(overrides: Partial<LogViewerServerOptions> = {}): Promise<Fixture> {
	const logsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "log-viewer-logs-"))
	const broadcast = new BroadcastSink()
	const server = await createLogViewerServer({
		logsDirectory,
		broadcast,
		activeSessionId: "active-session",
		...overrides,
	})

	const baseUrl = new URL(server.url)

	return {
		logsDirectory,
		broadcast,
		server,
		baseUrl,
		cleanup: async () => {
			await server.close()
			await fs.rm(logsDirectory, { recursive: true, force: true })
		},
	}
}

/** API URL with the fixture's token pre-filled. */
function apiUrl(fixture: Fixture, pathnameWithSearch: string): string {
	const url = new URL(pathnameWithSearch, fixture.baseUrl.origin)
	url.searchParams.set("token", fixture.baseUrl.searchParams.get("token") ?? "")

	return url.href
}

/**
 * Raw `http.request` status probe. Unlike `fetch`, it allows overriding the
 * `Host` header and sending un-normalized paths (for traversal attempts).
 */
function requestStatus(origin: string, requestPath: string, host?: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const url = new URL(origin)

		const request = http.request(
			{
				hostname: url.hostname,
				port: Number(url.port),
				path: requestPath,
				method: "GET",
				headers: host === undefined ? undefined : { Host: host },
			},
			(response) => {
				response.resume()
				response.on("end", () => resolve(response.statusCode ?? 0))
			},
		)

		request.on("error", reject)
		request.end()
	})
}

type SseEvent = { event: string; data: string }

function parseSseFrame(frame: string): SseEvent | undefined {
	let eventName: string | undefined
	const dataLines: string[] = []

	for (const line of frame.split("\n")) {
		if (line.startsWith(":")) {
			continue // heartbeat comment
		}

		if (line.startsWith("event:")) {
			eventName = line.slice("event:".length).trim()
		} else if (line.startsWith("data:")) {
			dataLines.push(line.slice("data:".length).trim())
		}
	}

	if (eventName === undefined || dataLines.length === 0) {
		return undefined
	}

	return { event: eventName, data: dataLines.join("\n") }
}

/**
 * Incrementally reads SSE frames from an already acquired stream reader until
 * `isDone` is satisfied. The reader stays locked, so the caller can keep
 * reading (and must cancel it to close the connection).
 */
async function readSseEvents(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	isDone: (events: SseEvent[]) => boolean,
): Promise<SseEvent[]> {
	const decoder = new TextDecoder()
	const events: SseEvent[] = []
	let buffer = ""
	const deadline = Date.now() + 5_000

	while (!isDone(events)) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for SSE events")
		}

		const { value, done } = await reader.read()

		if (done) {
			break
		}

		buffer += decoder.decode(value, { stream: true })

		let separatorIndex = buffer.indexOf("\n\n")

		while (separatorIndex !== -1) {
			const frame = buffer.slice(0, separatorIndex)
			buffer = buffer.slice(separatorIndex + 2)

			const parsed = parseSseFrame(frame)

			if (parsed) {
				events.push(parsed)
			}

			separatorIndex = buffer.indexOf("\n\n")
		}
	}

	return events
}

// These tests exercise a real loopback listener; the global nock policy in
// `vitest.setup.ts` blocks all net connections by default.
beforeAll(() => {
	allowNetConnect("127.0.0.1")
})

afterAll(() => {
	nock.disableNetConnect()
})

describe("log-viewer server", () => {
	it("serves the placeholder page on GET /", async () => {
		const fixture = await startFixture()

		try {
			const response = await fetch(`${fixture.baseUrl.origin}/`)

			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toContain("text/html")

			const html = await response.text()
			expect(html).toContain("Zoo Code Harness Log Viewer")
		} finally {
			await fixture.cleanup()
		}
	})

	it("rejects API requests without a token", async () => {
		const fixture = await startFixture()

		try {
			const response = await fetch(new URL("/api/sessions", fixture.baseUrl.origin))

			expect(response.status).toBe(403)
		} finally {
			await fixture.cleanup()
		}
	})

	it("accepts a Bearer token", async () => {
		const fixture = await startFixture()

		try {
			const token = fixture.baseUrl.searchParams.get("token") ?? ""
			const response = await fetch(new URL("/api/sessions", fixture.baseUrl.origin), {
				headers: { Authorization: `Bearer ${token}` },
			})

			expect(response.status).toBe(200)

			const body = (await response.json()) as { sessions: HarnessLogSessionSummary[] }
			expect(body.sessions).toEqual([])
		} finally {
			await fixture.cleanup()
		}
	})

	it("rejects requests with a foreign Host header", async () => {
		const fixture = await startFixture()

		try {
			const token = fixture.baseUrl.searchParams.get("token") ?? ""
			const status = await requestStatus(
				fixture.baseUrl.origin,
				`/api/sessions?token=${token}`,
				"evil.example.com",
			)

			expect(status).toBe(403)
		} finally {
			await fixture.cleanup()
		}
	})

	it("lists sessions sorted by modification time with the active flag", async () => {
		const fixture = await startFixture({ activeSessionId: "older" })

		try {
			await fs.writeFile(path.join(fixture.logsDirectory, "older.jsonl"), '{"index":0}\n')
			await fs.writeFile(path.join(fixture.logsDirectory, "newer.jsonl"), '{"index":1}\n{"index":2}\n')

			const olderTime = new Date("2026-01-01T00:00:00Z")
			const newerTime = new Date("2026-01-02T00:00:00Z")

			await fs.utimes(path.join(fixture.logsDirectory, "older.jsonl"), olderTime, olderTime)
			await fs.utimes(path.join(fixture.logsDirectory, "newer.jsonl"), newerTime, newerTime)

			const response = await fetch(apiUrl(fixture, "/api/sessions"))

			expect(response.status).toBe(200)

			const body = (await response.json()) as { sessions: HarnessLogSessionSummary[] }

			expect(body.sessions.map((session) => session.id)).toEqual(["newer", "older"])
			expect(body.sessions[0]).toMatchObject({
				id: "newer",
				fileName: "newer.jsonl",
				sizeBytes: '{"index":1}\n{"index":2}\n'.length,
				modifiedAt: newerTime.toISOString(),
				active: false,
			})
			expect(body.sessions[1]).toMatchObject({ id: "older", fileName: "older.jsonl", active: true })
		} finally {
			await fixture.cleanup()
		}
	})

	it("paginates stitched rotations and skips corrupted lines", async () => {
		const fixture = await startFixture()

		try {
			await fs.writeFile(path.join(fixture.logsDirectory, "s1.jsonl.1"), '{"index":0}\n{"index":1}\n')
			await fs.writeFile(
				path.join(fixture.logsDirectory, "s1.jsonl"),
				'{"index":2}\n{"broken tail"\n{"index":3}\n',
			)

			const first = await fetch(apiUrl(fixture, "/api/sessions/s1/records?after=1&limit=2"))

			expect(first.status).toBe(200)

			const firstBody = (await first.json()) as SessionRecordsPage

			expect(firstBody.records).toEqual([{ index: 1 }, { index: 2 }])
			expect(firstBody.nextAfter).toBe(3)

			const second = await fetch(apiUrl(fixture, "/api/sessions/s1/records?after=3"))
			const secondBody = (await second.json()) as SessionRecordsPage

			expect(secondBody.records).toEqual([{ index: 3 }])
			expect(secondBody.nextAfter).toBeNull()
		} finally {
			await fixture.cleanup()
		}
	})

	it("refuses session ids containing path traversal", async () => {
		const fixture = await startFixture()

		try {
			const token = fixture.baseUrl.searchParams.get("token") ?? ""

			// Raw `..` segment: `fetch` would normalize it away, so probe via http.
			const dotted = await requestStatus(fixture.baseUrl.origin, `/api/sessions/../records?token=${token}`)
			expect(dotted).toBe(404)

			// Encoded separators survive URL parsing and must still be refused.
			const encoded = await fetch(apiUrl(fixture, "/api/sessions/..%2F..%2Fsecret/records"))
			expect(encoded.status).toBe(404)
		} finally {
			await fixture.cleanup()
		}
	})

	it("streams a backfill batch and live records over SSE", async () => {
		const fixture = await startFixture()

		try {
			fixture.broadcast.write(record("harness.event.one"))
			fixture.broadcast.write(record("harness.event.two"))

			const response = await fetch(apiUrl(fixture, "/api/events"))

			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toContain("text/event-stream")
			expect(response.headers.get("cache-control")).toBe("no-cache")

			if (!response.body) {
				throw new Error("SSE response has no body")
			}

			const reader = response.body.getReader()

			const batchEvents = await readSseEvents(reader, (events) => events.some((event) => event.event === "batch"))

			const batch = batchEvents.find((event) => event.event === "batch")

			expect(batch).toBeDefined()
			expect(JSON.parse(batch?.data ?? "[]")).toMatchObject([
				{ name: "harness.event.one" },
				{ name: "harness.event.two" },
			])

			// Live record: written after the backfill was consumed.
			fixture.broadcast.write(record("harness.event.live"))

			const liveEvents = await readSseEvents(reader, (events) => events.some((event) => event.event === "record"))

			const live = liveEvents.find((event) => event.event === "record")

			expect(live).toBeDefined()
			expect(JSON.parse(live?.data ?? "{}")).toMatchObject({ name: "harness.event.live" })

			await reader.cancel()
		} finally {
			await fixture.cleanup()
		}
	})

	it("serves static assets from the public directory when provided", async () => {
		const publicDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "log-viewer-public-"))
		const fixture = await startFixture({ publicDirectory })

		try {
			await fs.writeFile(path.join(publicDirectory, "index.html"), "<html>viewer page</html>")
			await fs.writeFile(path.join(publicDirectory, "app.js"), "console.log('app')")
			await fs.writeFile(path.join(publicDirectory, "styles.css"), "body {}")

			const page = await fetch(`${fixture.baseUrl.origin}/`)
			expect(await page.text()).toBe("<html>viewer page</html>")

			const script = await fetch(`${fixture.baseUrl.origin}/app.js`)
			expect(script.status).toBe(200)
			expect(script.headers.get("content-type")).toContain("text/javascript")
			expect(await script.text()).toBe("console.log('app')")

			const styles = await fetch(`${fixture.baseUrl.origin}/styles.css`)
			expect(styles.status).toBe(200)
			expect(styles.headers.get("content-type")).toContain("text/css")
		} finally {
			await fixture.cleanup()
			await fs.rm(publicDirectory, { recursive: true, force: true })
		}
	})
})

describe("log-viewer server singleton", () => {
	afterEach(async () => {
		await closeLogViewerServer()
	})

	it("returns the running instance on repeated calls and restarts after close", async () => {
		const logsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "log-viewer-logs-"))
		const broadcast = new BroadcastSink()

		try {
			const first = await getOrCreateLogViewerServer({
				logsDirectory,
				broadcast,
				activeSessionId: "session-1",
			})

			// Later options are ignored while the server is up.
			const second = await getOrCreateLogViewerServer({
				logsDirectory,
				broadcast,
				activeSessionId: "session-2",
			})

			expect(second.url).toBe(first.url)

			await closeLogViewerServer()

			const third = await getOrCreateLogViewerServer({
				logsDirectory,
				broadcast,
				activeSessionId: "session-1",
			})

			expect(third.url).not.toBe(first.url)
		} finally {
			await closeLogViewerServer()
			await fs.rm(logsDirectory, { recursive: true, force: true })
		}
	})
})
