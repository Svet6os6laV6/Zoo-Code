/**
 * Local HTTP/SSE server for the harness log viewer.
 *
 * Serves three surfaces on a loopback-only listener:
 * - the static viewer page (a placeholder until T03 ships `log-viewer/public/`);
 * - JSON history endpoints over the JSONL session files;
 * - a live SSE stream fanned out from `BroadcastSink`.
 *
 * Security model: the server binds to 127.0.0.1 only, requires a per-start
 * random token for every `/api/*` route (query parameter or Bearer header) and
 * rejects requests whose `Host` header is not loopback (DNS-rebinding
 * protection). Server errors never reach the harness: they are reported
 * through the optional `onError` callback and the request fails closed.
 */

import * as fs from "fs/promises"
import * as http from "http"
import * as path from "path"
import { randomBytes, timingSafeEqual } from "crypto"

import type { BroadcastSink, HarnessLogRecord } from "@roo-code/core"

import { DEFAULT_SESSION_RECORDS_LIMIT, listSessions, readSessionRecords } from "./sessions"

export const LOG_VIEWER_HOSTNAME = "127.0.0.1"
const SSE_HEARTBEAT_INTERVAL_MS = 15_000

export type LogViewerServerOptions = {
	/** Directory with `<sessionId>.jsonl` files and their rotations. */
	readonly logsDirectory: string
	/** Live record source: `recent()` backfill + `subscribe()` stream. */
	readonly broadcast: BroadcastSink
	/** Session id of the current harness run; flagged `active` in the session list. */
	readonly activeSessionId: string
	/** Optional directory with static viewer assets (`index.html`, `app.js`, `styles.css`). */
	readonly publicDirectory?: string
	/** Called for server-side errors that must not reach the harness. */
	readonly onError?: (error: unknown) => void
}

export type LogViewerServer = {
	/** Viewer URL including the auth token: `http://127.0.0.1:<port>/?token=<token>`. */
	readonly url: string
	/** Stops the listener and destroys open connections. Close errors are swallowed. */
	close(): Promise<void>
}

const PLACEHOLDER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>Zoo Code Harness Log Viewer</title>
</head>
<body>
	<h1>Zoo Code Harness Log Viewer</h1>
	<p>The viewer page is not bundled yet. The JSON API and the SSE stream are live.</p>
</body>
</html>
`

/** Starts a new independent server instance. Tests manage the lifecycle themselves. */
export async function createLogViewerServer(options: LogViewerServerOptions): Promise<LogViewerServer> {
	const token = randomBytes(32).toString("hex")

	const server = http.createServer((req, res) => {
		void handleRequest(req, res, options, token).catch((error) => {
			options.onError?.(error)

			try {
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" })
				}

				res.end(JSON.stringify({ error: "internal error" }))
			} catch {
				// The client is gone; nothing to report.
			}
		})
	})

	server.on("error", (error) => options.onError?.(error))

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, LOG_VIEWER_HOSTNAME, () => resolve())
	})

	const address = server.address()

	if (typeof address !== "object" || address === null) {
		server.close()
		throw new Error("Log viewer server did not report a TCP address")
	}

	return {
		url: `http://${LOG_VIEWER_HOSTNAME}:${address.port}/?token=${token}`,
		close: () =>
			new Promise<void>((resolve) => {
				// SSE connections are keep-alive: destroy them so close() completes.
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
}

let activeServer: LogViewerServer | undefined

/**
 * Starts the singleton log viewer server, or returns the already running one.
 * The first call wins: later options are ignored while the server is up.
 */
export async function getOrCreateLogViewerServer(options: LogViewerServerOptions): Promise<LogViewerServer> {
	if (activeServer) {
		return activeServer
	}

	activeServer = await createLogViewerServer(options)

	return activeServer
}

/** Stops the singleton server if it is running; close errors are swallowed. */
export async function closeLogViewerServer(): Promise<void> {
	const server = activeServer
	activeServer = undefined

	if (!server) {
		return
	}

	await server.close()
}

async function handleRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	options: LogViewerServerOptions,
	token: string,
): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${LOG_VIEWER_HOSTNAME}`)

	if (!isLoopbackHost(req.headers.host)) {
		sendText(res, 403, "Forbidden")
		return
	}

	if (req.method !== "GET" && req.method !== "HEAD") {
		sendText(res, 405, "Method Not Allowed")
		return
	}

	switch (url.pathname) {
		case "/":
		case "/index.html":
			await servePage(res, options)
			return

		case "/app.js":
		case "/styles.css":
			await serveAsset(url.pathname, res, options)
			return

		case "/api/sessions":
			if (!ensureAuthorized(req, res, url, token)) {
				return
			}

			sendJson(res, 200, { sessions: await listSessions(options.logsDirectory, options.activeSessionId) })
			return

		case "/api/events":
			if (!ensureAuthorized(req, res, url, token)) {
				return
			}

			handleSseStream(res, options)
			return
	}

	const recordsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/records$/)

	if (recordsMatch) {
		if (!ensureAuthorized(req, res, url, token)) {
			return
		}

		let sessionId: string

		try {
			sessionId = decodeURIComponent(recordsMatch[1])
		} catch {
			sendText(res, 404, "Not Found")
			return
		}

		const page = await readSessionRecords(options.logsDirectory, sessionId, {
			after: parseNonNegativeInteger(url.searchParams.get("after")) ?? 0,
			limit: parseNonNegativeInteger(url.searchParams.get("limit")) ?? DEFAULT_SESSION_RECORDS_LIMIT,
		})

		if (!page) {
			// Unknown or malformed session id: refuse without touching the file system.
			sendText(res, 404, "Not Found")
			return
		}

		sendJson(res, 200, page)
		return
	}

	sendText(res, 404, "Not Found")
}

function handleSseStream(res: http.ServerResponse, options: LogViewerServerOptions): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	})

	const send = (payload: string): void => {
		try {
			res.write(payload)
		} catch {
			// A dead client is cleaned up by the `close` handler below.
		}
	}

	// Backfill first, then live records. A record written in between is picked
	// up by the client through the session history endpoints.
	send(`event: batch\ndata: ${JSON.stringify(options.broadcast.recent())}\n\n`)

	const unsubscribe = options.broadcast.subscribe((record: HarnessLogRecord) => {
		send(`event: record\ndata: ${JSON.stringify(record)}\n\n`)
	})

	const heartbeat = setInterval(() => send(": heartbeat\n\n"), SSE_HEARTBEAT_INTERVAL_MS)

	res.on("close", () => {
		clearInterval(heartbeat)
		unsubscribe()
	})
}

async function servePage(res: http.ServerResponse, options: LogViewerServerOptions): Promise<void> {
	const html = await readPublicFile(options, "index.html")

	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
	res.end(html ?? PLACEHOLDER_HTML)
}

async function serveAsset(pathname: string, res: http.ServerResponse, options: LogViewerServerOptions): Promise<void> {
	const content = await readPublicFile(options, pathname.slice(1))

	if (content === undefined) {
		sendText(res, 404, "Not Found")
		return
	}

	res.writeHead(200, { "Content-Type": contentTypeFor(pathname) })
	res.end(content)
}

/** Reads a viewer asset from the optional public directory; `undefined` when absent or unreadable. */
async function readPublicFile(options: LogViewerServerOptions, fileName: string): Promise<string | undefined> {
	if (!options.publicDirectory) {
		return undefined
	}

	try {
		return await fs.readFile(path.join(options.publicDirectory, fileName), "utf8")
	} catch {
		return undefined
	}
}

function contentTypeFor(pathname: string): string {
	if (pathname === "/app.js") {
		return "text/javascript; charset=utf-8"
	}

	return "text/css; charset=utf-8"
}

function isLoopbackHost(host: string | undefined): boolean {
	if (!host) {
		return false
	}

	// The Host header is `hostname[:port]`; the listener is IPv4 loopback, so
	// splitting on the first colon is safe.
	const hostname = host.split(":", 1)[0].toLowerCase()

	return hostname === "127.0.0.1" || hostname === "localhost"
}

/**
 * Guard for every `/api/*` route: answers 403 and returns `false` when the
 * request is not authorized, so the caller can stop handling it.
 */
function ensureAuthorized(req: http.IncomingMessage, res: http.ServerResponse, url: URL, token: string): boolean {
	if (isAuthorized(req, url, token)) {
		return true
	}

	sendText(res, 403, "Forbidden")
	return false
}

function isAuthorized(req: http.IncomingMessage, url: URL, token: string): boolean {
	if (tokensEqual(url.searchParams.get("token") ?? "", token)) {
		return true
	}

	const header = req.headers.authorization

	return typeof header === "string" && tokensEqual(header.replace(/^Bearer /, ""), token)
}

function tokensEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false
	}

	return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

function parseNonNegativeInteger(value: string | null): number | undefined {
	if (value === null) {
		return undefined
	}

	const parsed = Number.parseInt(value, 10)

	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
	res.end(body)
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
	res.end(JSON.stringify(body))
}
