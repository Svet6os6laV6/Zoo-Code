/**
 * Harness logging wiring.
 *
 * Builds the process-wide harness logger from two sinks:
 * - a dedicated "Zoo Code Harness" output channel for humans;
 * - a per-session JSONL file in extension storage for structured analysis.
 *
 * The logger is installed as the root logger, so every harness module picks it
 * up without constructor plumbing.
 */

import * as path from "path"

import {
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

	const logger = new HarnessLogger({
		context: { sessionId },
		sinks: [
			// The output channel is the human-facing surface. Include the structured
			// payload (input/result/stateBefore/stateAfter/attributes) so a decision or
			// mutation is reviewable directly in the channel, not only in the JSONL file.
			new OutputChannelSink({ channel: options.channel, includePayload: true }),
			new JsonlSink({ filePath: jsonlPath, onError: (error) => reportSinkError(error, "jsonl") }),
		],
		onSinkError: (error, sink) => reportSinkError(error, sink.name),
	})

	setRootHarnessLogger(logger)

	return {
		logger,
		sessionId,
		jsonlPath,
		flush: () => logger.flush(),
	}
}
