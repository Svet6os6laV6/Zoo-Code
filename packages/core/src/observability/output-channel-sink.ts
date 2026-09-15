/**
 * OutputChannelSink
 *
 * Human-readable destination for a VSCode-like output channel. Declared against
 * a structural port (`appendLine`) rather than `vscode.OutputChannel`, so this
 * module stays platform-agnostic and a real `vscode.OutputChannel` can be passed
 * as-is.
 *
 * The channel line is a summary: identity, outcome, and reason. Full payloads
 * belong in the JSONL sink.
 */

import { HARNESS_LOG_LEVEL_RANK, type HarnessLogLevel, type HarnessLogRecord, type HarnessLogSink } from "./types.js"

export type HarnessOutputChannel = {
	appendLine(value: string): void
}

export type OutputChannelSinkOptions = {
	readonly channel: HarnessOutputChannel
	/** Records below this level are not written to the channel. */
	readonly minLevel?: HarnessLogLevel
	/** Appends the JSON payload to each line. Off by default: the channel is for humans. */
	readonly includePayload?: boolean
	readonly maxLineLength?: number
}

const DEFAULT_MAX_LINE_LENGTH = 2_000

export class OutputChannelSink implements HarnessLogSink {
	readonly name = "output-channel"

	private readonly channel: HarnessOutputChannel
	private readonly minLevelRank: number
	private readonly includePayload: boolean
	private readonly maxLineLength: number

	constructor(options: OutputChannelSinkOptions) {
		this.channel = options.channel
		this.minLevelRank = HARNESS_LOG_LEVEL_RANK[options.minLevel ?? "debug"]
		this.includePayload = options.includePayload ?? false
		this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH
	}

	write(record: HarnessLogRecord): void {
		if (HARNESS_LOG_LEVEL_RANK[record.level] < this.minLevelRank) {
			return
		}
		this.channel.appendLine(this.format(record))
	}

	private format(record: HarnessLogRecord): string {
		const parts: string[] = [
			record.timestamp,
			`[${record.level.toUpperCase()}]`,
			record.kind,
			record.name,
			`trace=${record.context.traceId}`,
			`session=${record.context.sessionId}`,
		]

		if (record.context.taskId) {
			parts.push(`task=${record.context.taskId}`)
		}
		if (record.context.txxId) {
			parts.push(`txx=${record.context.txxId}`)
		}
		if (record.context.mode) {
			parts.push(`mode=${record.context.mode}`)
		}
		if (record.target) {
			parts.push(`target=${record.target}`)
		}
		if (record.reason) {
			parts.push(`reason=${record.reason}`)
		}
		if (record.status) {
			parts.push(`status=${record.status}`)
		}
		if (typeof record.durationMs === "number") {
			parts.push(`durationMs=${record.durationMs}`)
		}
		if (record.error) {
			parts.push(`error=${record.error.name}: ${record.error.message}`)
		}
		if (this.includePayload) {
			parts.push(this.serializePayload(record))
		}

		const line = parts.join(" ")
		return line.length > this.maxLineLength ? `${line.slice(0, this.maxLineLength)}…` : line
	}

	private serializePayload(record: HarnessLogRecord): string {
		try {
			return JSON.stringify({
				input: record.input,
				result: record.result,
				stateBefore: record.stateBefore,
				stateAfter: record.stateAfter,
				attributes: record.attributes,
			})
		} catch {
			return "[unserializable payload]"
		}
	}
}
