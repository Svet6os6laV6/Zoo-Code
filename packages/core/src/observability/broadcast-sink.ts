/**
 * BroadcastSink
 *
 * In-memory fan-out destination for the harness logger: keeps the most recent
 * records in a ring buffer and synchronously hands each new record to every
 * active subscriber. This is the bridge between `HarnessLogger` and live
 * consumers such as the task web UI: `recent()` provides the backfill snapshot
 * and `subscribe()` provides the live stream.
 *
 * The sink is synchronous and never throws: a failing listener is isolated so
 * the remaining subscribers still receive the record and `write()` stays a
 * plain `void` per the `HarnessLogSink` contract.
 */

import type { HarnessLogRecord, HarnessLogSink } from "./types.js"

export type BroadcastSinkListener = (record: HarnessLogRecord) => void

export type BroadcastSinkOptions = {
	/** Maximum number of records kept for `recent()`. Older records are evicted. */
	readonly capacity?: number
	/** Called when a listener throws. When omitted, listener errors are dropped. */
	readonly onListenerError?: (error: unknown, record: HarnessLogRecord) => void
}

export const DEFAULT_BROADCAST_CAPACITY = 2_000

export class BroadcastSink implements HarnessLogSink {
	readonly name = "broadcast"

	private readonly capacity: number
	private readonly onListenerError: BroadcastSinkOptions["onListenerError"]
	private readonly buffer: HarnessLogRecord[] = []
	private readonly listeners = new Set<BroadcastSinkListener>()

	constructor(options: BroadcastSinkOptions = {}) {
		this.capacity = Math.max(1, options.capacity ?? DEFAULT_BROADCAST_CAPACITY)
		this.onListenerError = options.onListenerError
	}

	write(record: HarnessLogRecord): void {
		this.buffer.push(record)

		if (this.buffer.length > this.capacity) {
			this.buffer.splice(0, this.buffer.length - this.capacity)
		}

		for (const listener of this.listeners) {
			try {
				listener(record)
			} catch (error) {
				this.onListenerError?.(error, record)
			}
		}
	}

	/**
	 * Registers a listener for every record written from now on. Returns an
	 * unsubscribe function that is safe to call more than once.
	 */
	subscribe(listener: BroadcastSinkListener): () => void {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	/** Snapshot of the buffered records in write order (oldest → newest). */
	recent(): readonly HarnessLogRecord[] {
		return [...this.buffer]
	}

	flush(): void {
		// In-memory sink: nothing to flush.
	}
}
