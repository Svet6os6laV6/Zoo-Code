/**
 * JsonlSink
 *
 * Append-only JSONL log destination. One record per line, so a reader can
 * `grep`/`jq` a session without parsing the whole file, and a torn record only
 * ever costs the last line.
 *
 * Writes are serialized through a promise chain: the harness emits from many
 * concurrent spans, and an interleaved append plus rotation would corrupt the
 * file. Size-based rotation keeps a long-running session bounded.
 */

import { promises as fs } from "fs"
import * as path from "path"

import { isFileNotFound } from "../fs-errors.js"
import type { HarnessLogRecord, HarnessLogSink } from "./types.js"

/**
 * The subset of `fs.promises` the sink needs. Injected so unit tests never
 * touch the real disk, matching the rest of the harness modules.
 */
export type JsonlSinkFileSystem = {
	/** `fs.promises.mkdir(..., { recursive: true })` resolves to the created path (or undefined). */
	mkdir(dirPath: string, options: { recursive: true }): Promise<unknown>
	appendFile(filePath: string, data: string, encoding: "utf8"): Promise<void>
	stat(filePath: string): Promise<{ size: number }>
	rename(oldPath: string, newPath: string): Promise<void>
	rm(filePath: string, options: { force: true }): Promise<void>
}

export type JsonlSinkOptions = {
	/** Full path of the active log file. Parent directories are created lazily. */
	readonly filePath: string
	/** Rotate once the active file would exceed this many bytes. */
	readonly maxBytes?: number
	/** How many rotated files to keep (`.1`, `.2`, …). `0` disables history. */
	readonly maxArchives?: number
	readonly fileSystem?: JsonlSinkFileSystem
	readonly onError?: (error: unknown) => void
}

export const DEFAULT_JSONL_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_JSONL_MAX_ARCHIVES = 3

export class JsonlSink implements HarnessLogSink {
	readonly name = "jsonl"
	readonly filePath: string

	private readonly directory: string
	private readonly maxBytes: number
	private readonly maxArchives: number
	private readonly fileSystem: JsonlSinkFileSystem
	private readonly onError?: (error: unknown) => void

	private queue: Promise<void> = Promise.resolve()
	/** Lazily seeded from `stat`, then tracked in memory. */
	private bytesWritten: number | null = null
	private directoryEnsured = false
	private closed = false

	constructor(options: JsonlSinkOptions) {
		this.filePath = options.filePath
		this.directory = path.dirname(options.filePath)
		this.maxBytes = options.maxBytes ?? DEFAULT_JSONL_MAX_BYTES
		this.maxArchives = Math.max(0, options.maxArchives ?? DEFAULT_JSONL_MAX_ARCHIVES)
		this.fileSystem = options.fileSystem ?? fs
		this.onError = options.onError
	}

	write(record: HarnessLogRecord): void {
		if (this.closed) {
			return
		}

		let line: string
		try {
			line = `${JSON.stringify(record)}\n`
		} catch (error) {
			// An unserializable record must not break the harness or the queue.
			this.report(error)
			return
		}

		this.queue = this.queue.then(() => this.append(line)).catch((error: unknown) => this.report(error))
	}

	async flush(): Promise<void> {
		await this.queue
	}

	/** Stops accepting writes and drains the queue. */
	async close(): Promise<void> {
		this.closed = true
		await this.flush()
	}

	private async append(line: string): Promise<void> {
		await this.ensureDirectory()

		const bytes = Buffer.byteLength(line, "utf8")
		await this.rotateIfNeeded(bytes)
		await this.fileSystem.appendFile(this.filePath, line, "utf8")
		this.bytesWritten = (this.bytesWritten ?? 0) + bytes
	}

	private async ensureDirectory(): Promise<void> {
		if (this.directoryEnsured) {
			return
		}
		await this.fileSystem.mkdir(this.directory, { recursive: true })
		this.directoryEnsured = true
	}

	private async rotateIfNeeded(incomingBytes: number): Promise<void> {
		if (this.bytesWritten === null) {
			this.bytesWritten = await this.currentSize()
		}

		if (this.maxBytes <= 0 || this.bytesWritten === 0) {
			return
		}
		if (this.bytesWritten + incomingBytes <= this.maxBytes) {
			return
		}

		await this.rotate()
	}

	private async currentSize(): Promise<number> {
		try {
			return (await this.fileSystem.stat(this.filePath)).size
		} catch (error) {
			if (isFileNotFound(error)) {
				return 0
			}
			throw error
		}
	}

	private async rotate(): Promise<void> {
		if (this.maxArchives === 0) {
			await this.fileSystem.rm(this.filePath, { force: true })
			this.bytesWritten = 0
			return
		}

		await this.fileSystem.rm(`${this.filePath}.${this.maxArchives}`, { force: true })

		for (let index = this.maxArchives - 1; index >= 1; index -= 1) {
			await this.renameIfExists(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`)
		}

		await this.renameIfExists(this.filePath, `${this.filePath}.1`)
		this.bytesWritten = 0
	}

	private async renameIfExists(oldPath: string, newPath: string): Promise<void> {
		try {
			await this.fileSystem.rename(oldPath, newPath)
		} catch (error) {
			if (!isFileNotFound(error)) {
				throw error
			}
		}
	}

	private report(error: unknown): void {
		try {
			this.onError?.(error)
		} catch {
			// Reporting must not throw.
		}
	}
}
