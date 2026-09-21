/**
 * Harness log viewer page.
 *
 * Vanilla JS, no build step. The page reads the auth token from
 * `location.search` (the server hands the token through the viewer URL) and
 * forwards it to every `/api/*` request. All record data is inserted through
 * `textContent`/`createElement` — never through `innerHTML`.
 *
 * The DOM keeps at most `MAX_DOM_ROWS` rows: a long live stream evicts the
 * oldest rows instead of degrading the tab.
 */
"use strict"

const MAX_DOM_ROWS = 2000
const MAX_STORED_RECORDS = 5000
const HISTORY_PAGE_SIZE = 500
const LEVELS = ["debug", "info", "warn", "error"]
const PAYLOAD_FIELDS = ["input", "result", "reason", "stateBefore", "stateAfter", "target", "attributes", "error"]
// Free-text search covers a narrower set than the expanded payload view.
const SEARCHABLE_PAYLOAD_FIELDS = ["input", "result", "stateBefore", "stateAfter", "attributes"]

const token = new URLSearchParams(window.location.search).get("token") || ""

const els = {
	sessionList: document.getElementById("session-list"),
	sidebarMessage: document.getElementById("sidebar-message"),
	refreshSessions: document.getElementById("refresh-sessions"),
	levelFilters: document.getElementById("level-filters"),
	kindFilter: document.getElementById("kind-filter"),
	taskFilter: document.getElementById("task-filter"),
	txxFilter: document.getElementById("txx-filter"),
	modeFilter: document.getElementById("mode-filter"),
	searchFilter: document.getElementById("search-filter"),
	connectionStatus: document.getElementById("connection-status"),
	pauseButton: document.getElementById("pause-button"),
	records: document.getElementById("records"),
	loadMore: document.getElementById("load-more"),
	recordsCount: document.getElementById("records-count"),
}

const state = {
	sessions: [],
	selectedSessionId: null,
	allRecords: [],
	seenKeys: new Set(),
	nextAfter: 0,
	hasMoreHistory: false,
	levels: new Set(LEVELS),
	paused: false,
	pending: [],
	autoScroll: true,
	eventSource: null,
	connection: "disconnected",
}

/* ------------------------------------------------------------------ utils */

function contextOf(record) {
	return record.context || {}
}

function recordKey(record) {
	const context = contextOf(record)

	return [record.timestamp, record.kind, record.name, context.traceId, context.spanId, context.sessionId].join("|")
}

function formatBytes(bytes) {
	if (typeof bytes !== "number" || !Number.isFinite(bytes)) {
		return "?"
	}

	if (bytes < 1024) {
		return `${bytes} B`
	}

	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`
	}

	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `Date` for a timestamp value, or null when the value is not parseable. */
function asDate(value) {
	const date = new Date(value)

	return Number.isNaN(date.getTime()) ? null : date
}

function formatTimestamp(value) {
	const date = asDate(value)

	return date ? date.toLocaleTimeString(undefined, { hour12: false }) : String(value)
}

function formatFullTimestamp(value) {
	const date = asDate(value)

	return date ? date.toLocaleString() : String(value)
}

function element(tag, className, text) {
	const node = document.createElement(tag)

	if (className) {
		node.className = className
	}

	if (text !== undefined) {
		node.textContent = text
	}

	return node
}

/* ------------------------------------------------------------------- auth */

async function apiFetch(pathname) {
	const url = new URL(pathname, window.location.origin)
	url.searchParams.set("token", token)

	const response = await fetch(url.href, { headers: { Authorization: `Bearer ${token}` } })

	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}`)
	}

	return response.json()
}

/* ---------------------------------------------------------------- sessions */

async function loadSessions() {
	try {
		const data = await apiFetch("/api/sessions")
		state.sessions = Array.isArray(data.sessions) ? data.sessions : []
		setSidebarMessage("")
		renderSessions()
	} catch (error) {
		setSidebarMessage(`Failed to load sessions: ${messageOf(error)}`)
	}
}

function setSidebarMessage(text) {
	els.sidebarMessage.textContent = text
	els.sidebarMessage.hidden = text === ""
}

function renderSessions() {
	els.sessionList.textContent = ""

	if (state.sessions.length === 0) {
		els.sessionList.appendChild(element("div", "empty-state", "No sessions yet"))
		return
	}

	for (const session of state.sessions) {
		const item = element("button", "session-item")
		item.type = "button"
		item.dataset.sessionId = session.id

		if (session.id === state.selectedSessionId) {
			item.classList.add("selected")
		}

		const name = element("span", "session-name")
		name.appendChild(element("span", "session-file", session.fileName || session.id))

		if (session.active) {
			name.appendChild(element("span", "session-badge", "active"))
		}

		const meta = element("span", "session-meta")
		meta.appendChild(element("span", "session-size", formatBytes(session.sizeBytes)))
		meta.appendChild(element("span", "session-date", formatFullTimestamp(session.modifiedAt)))

		item.appendChild(name)
		item.appendChild(meta)
		item.addEventListener("click", () => {
			void selectSession(session.id)
		})

		els.sessionList.appendChild(item)
	}
}

async function selectSession(sessionId) {
	if (sessionId === state.selectedSessionId) {
		return
	}

	state.selectedSessionId = sessionId
	state.allRecords = []
	state.seenKeys = new Set()
	state.pending = []
	state.nextAfter = 0
	state.hasMoreHistory = false
	resetRecordsView()
	renderSessions()

	await loadHistory()

	const session = state.sessions.find((candidate) => candidate.id === sessionId)

	if (session && session.active) {
		connectSse()
	} else {
		disconnectSse()
	}
}

/* ----------------------------------------------------------------- records */

/** Replaces the records pane with a single message (loading, empty or error). */
function showRecordsMessage(message) {
	els.records.textContent = ""
	els.records.appendChild(element("div", "empty-state", message))
}

function resetRecordsView() {
	showRecordsMessage(state.selectedSessionId ? "Loading…" : "Select a session")
	updateLoadMore()
	updateCount(0)
}

function passesFilter(record) {
	if (!state.levels.has(record.level)) {
		return false
	}

	if (els.kindFilter.value && record.kind !== els.kindFilter.value) {
		return false
	}

	const context = contextOf(record)

	if (els.taskFilter.value && (context.taskId || "") !== els.taskFilter.value) {
		return false
	}

	if (els.txxFilter.value && (context.txxId || "") !== els.txxFilter.value) {
		return false
	}

	if (els.modeFilter.value && (context.mode || "") !== els.modeFilter.value) {
		return false
	}

	const query = els.searchFilter.value.trim().toLowerCase()

	if (query && !searchText(record).includes(query)) {
		return false
	}

	return true
}

function searchText(record) {
	const context = contextOf(record)
	const parts = [record.name, record.level, record.kind, record.reason, context.taskId, context.txxId, context.mode]

	for (const field of SEARCHABLE_PAYLOAD_FIELDS) {
		if (record[field] !== undefined) {
			try {
				parts.push(JSON.stringify(record[field]))
			} catch {
				// Circular or otherwise unserializable payloads are not searchable.
			}
		}
	}

	return parts
		.filter((part) => typeof part === "string" && part.length > 0)
		.join(" ")
		.toLowerCase()
}

function ingestRecord(record) {
	const key = recordKey(record)

	if (state.seenKeys.has(key)) {
		return
	}

	state.seenKeys.add(key)
	state.allRecords.push(record)

	while (state.allRecords.length > MAX_STORED_RECORDS) {
		const removed = state.allRecords.shift()
		state.seenKeys.delete(recordKey(removed))
	}

	if (passesFilter(record)) {
		appendRow(record)
	}

	updateCount()
}

function addRecords(records) {
	if (!Array.isArray(records) || records.length === 0) {
		return
	}

	if (state.paused) {
		// Pause is a visual-only buffer: records keep arriving but stay out of
		// the DOM until the user resumes.
		state.pending.push(...records)
		return
	}

	for (const record of records) {
		ingestRecord(record)
	}
}

async function loadHistory() {
	if (!state.selectedSessionId) {
		return
	}

	try {
		const params = new URLSearchParams({
			after: String(state.nextAfter),
			limit: String(HISTORY_PAGE_SIZE),
		})
		const data = await apiFetch(
			`/api/sessions/${encodeURIComponent(state.selectedSessionId)}/records?${params.toString()}`,
		)

		state.nextAfter = typeof data.nextAfter === "number" ? data.nextAfter : 0
		state.hasMoreHistory = data.nextAfter !== null && data.nextAfter !== undefined

		if (state.allRecords.length === 0) {
			els.records.textContent = ""
		}

		// History is authoritative: bypass the pause buffer.
		for (const record of Array.isArray(data.records) ? data.records : []) {
			ingestRecord(record)
		}

		updateLoadMore()

		if (state.allRecords.length === 0) {
			showRecordsMessage("No records in this session")
		}
	} catch (error) {
		showRecordsMessage(`Failed to load records: ${messageOf(error)}`)
	}
}

/* --------------------------------------------------------------------- DOM */

function createRow(record) {
	const row = element("div", `record level-${record.level}`)
	row.dataset.key = recordKey(record)

	const main = element("div", "record-main")
	const time = element("span", "record-time", formatTimestamp(record.timestamp))
	time.title = formatFullTimestamp(record.timestamp)
	main.appendChild(time)
	main.appendChild(element("span", `level-badge level-${record.level}`, record.level))
	main.appendChild(element("span", "record-kind", record.kind))
	main.appendChild(element("span", "record-name", record.name))

	const context = contextOf(record)
	const chips = element("span", "chips")

	if (context.taskId) {
		chips.appendChild(element("span", "chip", `task=${context.taskId}`))
	}

	if (context.txxId) {
		chips.appendChild(element("span", "chip", `txx=${context.txxId}`))
	}

	if (context.mode) {
		chips.appendChild(element("span", "chip", `mode=${context.mode}`))
	}

	if (typeof record.durationMs === "number") {
		chips.appendChild(element("span", "chip", `${record.durationMs}ms`))
	}

	main.appendChild(chips)
	main.addEventListener("click", () => toggleDetails(row, main, record))

	row.appendChild(main)

	return row
}

function toggleDetails(row, main, record) {
	let details = row.querySelector(".record-details")

	if (!details) {
		details = element("pre", "record-details", detailsText(record))
		row.appendChild(details)
	}

	const expanded = !row.classList.contains("expanded")
	row.classList.toggle("expanded", expanded)
	details.hidden = !expanded
	main.setAttribute("aria-expanded", String(expanded))
}

function detailsText(record) {
	const payload = {}

	for (const field of PAYLOAD_FIELDS) {
		if (record[field] !== undefined) {
			payload[field] = record[field]
		}
	}

	if (Object.keys(payload).length === 0) {
		return "(no payload)"
	}

	try {
		return JSON.stringify(payload, null, 2)
	} catch {
		return "(payload is not serializable)"
	}
}

function appendRow(record) {
	if (els.records.querySelector(".empty-state")) {
		els.records.textContent = ""
	}

	els.records.appendChild(createRow(record))

	while (els.records.children.length > MAX_DOM_ROWS) {
		els.records.removeChild(els.records.firstElementChild)
	}

	if (state.autoScroll) {
		scrollToBottom()
	}
}

function renderAll() {
	const filtered = state.allRecords.filter(passesFilter)
	const visible = filtered.slice(-MAX_DOM_ROWS)

	els.records.textContent = ""

	if (visible.length === 0) {
		showRecordsMessage(state.selectedSessionId ? "No matching records" : "Select a session")
		updateCount(filtered.length)
		return
	}

	const fragment = document.createDocumentFragment()

	for (const record of visible) {
		fragment.appendChild(createRow(record))
	}

	els.records.appendChild(fragment)
	updateCount(filtered.length)

	if (state.autoScroll) {
		scrollToBottom()
	}
}

function scrollToBottom() {
	els.records.scrollTop = els.records.scrollHeight
}

function updateCount(filteredCount) {
	const total = state.allRecords.length
	const shown = filteredCount === undefined ? state.allRecords.filter(passesFilter).length : filteredCount
	const pausedSuffix = state.paused && state.pending.length > 0 ? ` — ${state.pending.length} buffered` : ""

	els.recordsCount.textContent = `${shown} / ${total} records${pausedSuffix}`
}

function updateLoadMore() {
	els.loadMore.hidden = !state.hasMoreHistory || !state.selectedSessionId
}

/* ---------------------------------------------------------------- live SSE */

function setConnection(status) {
	state.connection = status
	els.connectionStatus.textContent = status
	els.connectionStatus.className = `status status-${status}`
	els.pauseButton.disabled = status === "disconnected"
}

/** Parses an SSE `data:` payload; malformed frames are ignored and the stream stays open. */
function parseFrameData(data) {
	try {
		return JSON.parse(data)
	} catch {
		return undefined
	}
}

function connectSse() {
	disconnectSse()

	if (!token) {
		setConnection("disconnected")
		return
	}

	const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`)

	// The server sends the backfill on every (re)connect; `ingestRecord`
	// de-duplicates records that were already loaded from history.
	source.addEventListener("batch", (event) => addRecords(parseFrameData(event.data)))

	source.addEventListener("record", (event) => {
		const record = parseFrameData(event.data)

		if (record !== undefined) {
			addRecords([record])
		}
	})

	source.onopen = () => setConnection("connected")
	source.onerror = () => setConnection("reconnecting")
	state.eventSource = source
}

function disconnectSse() {
	if (state.eventSource) {
		state.eventSource.close()
		state.eventSource = null
	}

	setConnection("disconnected")
}

/* ------------------------------------------------------------------ events */

function messageOf(error) {
	return error instanceof Error ? error.message : String(error)
}

function bindEvents() {
	els.refreshSessions.addEventListener("click", () => {
		void loadSessions()
	})

	els.levelFilters.addEventListener("change", () => {
		state.levels = new Set(
			Array.from(els.levelFilters.querySelectorAll("input[type=checkbox]:checked")).map((input) => input.value),
		)
		renderAll()
	})

	for (const input of [els.kindFilter, els.taskFilter, els.txxFilter, els.modeFilter, els.searchFilter]) {
		input.addEventListener("input", () => renderAll())
		input.addEventListener("change", () => renderAll())
	}

	els.pauseButton.addEventListener("click", () => {
		state.paused = !state.paused
		els.pauseButton.textContent = state.paused ? "Resume" : "Pause"

		if (!state.paused) {
			const buffered = state.pending
			state.pending = []

			for (const record of buffered) {
				ingestRecord(record)
			}

			if (state.autoScroll) {
				scrollToBottom()
			}
		}

		updateCount()
	})

	els.loadMore.addEventListener("click", () => {
		void loadHistory()
	})

	els.records.addEventListener("scroll", () => {
		const distanceFromBottom = els.records.scrollHeight - els.records.scrollTop - els.records.clientHeight
		state.autoScroll = distanceFromBottom < 40
	})

	window.addEventListener("beforeunload", () => disconnectSse())
}

bindEvents()
resetRecordsView()
void loadSessions()
