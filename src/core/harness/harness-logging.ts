/**
 * Harness logging wiring.
 *
 * Builds the process-wide harness logger from three sinks:
 * - a dedicated "Zoo Code Harness" output channel for humans;
 * - a per-session JSONL file in extension storage for structured analysis;
 * - an in-memory `BroadcastSink` fanning records out to live consumers
 *   (the log viewer SSE stream).
 *
 * The logger is installed as the root logger, so every harness module picks it
 * up without constructor plumbing.
 */

import * as path from "path"

import {
	BroadcastSink,
	HarnessLogger,
	JsonlSink,
	OutputChannelSink,
	setRootHarnessLogger,
	type HarnessLoggerPort,
} from "@roo-code/core"

import { getStorageBasePath } from "../../utils/storage"

export const HARNESS_OUTPUT_CHANNEL_NAME = "Zoo Code Harness"
export const HARNESS_LOG_DIRECTORY = "harness-logs"

/** Structural port: a real `vscode.OutputChannel` satisfies it. */
export type HarnessOutputChannelLike = {
	appendLine(value: string): void
}

export type HarnessLoggingHandle = {
	readonly logger: HarnessLoggerPort
	readonly sessionId: string
	readonly jsonlPath: string
	/** In-memory fan-out sink for live consumers (log viewer SSE). */
	readonly broadcast: BroadcastSink
	flush(): Promise<void>
}

/**
 * Session id used for the JSONL file name: sortable by time and
 * collision-resistant across windows.
 */
export function createHarnessSessionId(now: Date = new Date(), random: () => number = Math.random): string {
	const stamp = now.toISOString().replace(/[:.]/g, "-")
	const suffix = Math.floor(random() * 0xffffffff)
		.toString(16)
		.padStart(8, "0")

	return `${stamp}-${suffix}`
}

export async function initializeHarnessLogging(options: {
	globalStoragePath: string
	channel: HarnessOutputChannelLike
	sessionId?: string
}): Promise<HarnessLoggingHandle> {
	const sessionId = options.sessionId ?? createHarnessSessionId()
	const basePath = await getStorageBasePath(options.globalStoragePath)
	const jsonlPath = path.join(basePath, HARNESS_LOG_DIRECTORY, `${sessionId}.jsonl`)

	const reportSinkError = (error: unknown, sinkName: string): void => {
		try {
			options.channel.appendLine(
				`[harness] ${sinkName} sink error: ${error instanceof Error ? error.message : String(error)}`,
			)
		} catch {
			// Reporting a sink failure must not become a new failure.
		}
	}

	const broadcast = new BroadcastSink()

	const logger = new HarnessLogger({
		context: { sessionId },
		sinks: [
			// The output channel is the human-facing surface. Include the structured
			// payload (input/result/stateBefore/stateAfter/attributes) so a decision or
			// mutation is reviewable directly in the channel, not only in the JSONL file.
			new OutputChannelSink({ channel: options.channel, includePayload: true }),
			new JsonlSink({ filePath: jsonlPath, onError: (error) => reportSinkError(error, "jsonl") }),
			// In-memory fan-out for live consumers; a misbehaving subscriber is
			// isolated inside the sink and never reaches the harness.
			broadcast,
		],
		onSinkError: (error, sink) => reportSinkError(error, sink.name),
	})

	setRootHarnessLogger(logger)

	return {
		logger,
		sessionId,
		jsonlPath,
		broadcast,
		flush: () => logger.flush(),
	}
}
