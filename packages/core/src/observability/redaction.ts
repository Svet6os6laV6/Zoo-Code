/**
 * Redaction for harness logs.
 *
 * Full prompt logging is opt-in and must never leak credentials into the log
 * file. Every payload that can contain provider configuration, environment
 * dumps, or tool output goes through this module before it is written.
 *
 * The redactor is deliberately conservative in one direction only: it prefers
 * over-redaction to leakage. Long strings are truncated so a single prompt
 * cannot dominate a log file.
 */

import type { HarnessLogRecord } from "./types.js"

export const REDACTED = "[redacted]"

export type RedactOptions = {
	/** Additional literal secrets to mask, for example a key read from settings. */
	readonly extraSecrets?: readonly string[]
	readonly maxStringLength?: number
	readonly maxDepth?: number
	readonly maxArrayItems?: number
	readonly maxObjectKeys?: number
}

const DEFAULT_MAX_STRING_LENGTH = 4_000
const DEFAULT_MAX_DEPTH = 6
const DEFAULT_MAX_ARRAY_ITEMS = 50
const DEFAULT_MAX_OBJECT_KEYS = 100

/**
 * Credential shapes that are recognizable without any key context.
 *
 * Order matters only in that the private-key block is matched first so a
 * multi-line key never gets partially masked by a line-oriented pattern.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	/\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{12,}/g,
	/\bsk-or-v1-[A-Za-z0-9]{16,}/g,
	/\bglpat-[A-Za-z0-9_-]{10,}/g,
	/\bghp_[A-Za-z0-9]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
	/\bAIza[0-9A-Za-z_-]{20,}/g,
	/\br8_[A-Za-z0-9]{20,}/g,
]

/**
 * URL userinfo. Handled separately from the patterns above because it keeps the
 * user name: only the password is a credential.
 */
const URL_CREDENTIALS_PATTERN = /:\/\/([^\s:@/]+):([^\s@/]+)@/g

/**
 * `NAME=value` / `NAME: value` assignments for credential-looking names, which
 * is how environment dumps and settings excerpts appear inside prompts.
 */
const SECRET_ASSIGNMENT_PATTERN =
	/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*[=:]\s*("?)([^\s"'\n]{6,})\2/g

const SENSITIVE_KEY_PARTS: readonly string[] = [
	"apikey",
	"apitoken",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"authtoken",
	"sessiontoken",
	"sessionkey",
	"accesskey",
	"privatekey",
	"clientsecret",
	"clientid",
	"token",
	"secret",
	"password",
	"passwd",
	"credential",
	"credentials",
	"authorization",
	"authheader",
	"cookie",
	"setcookie",
	"connectionstring",
]

function normalizeKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/** True when an object key conventionally holds a credential. */
export function isSensitiveKey(key: string): boolean {
	const normalized = normalizeKey(key)
	return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))
}

function truncate(value: string, maxStringLength: number): string {
	if (value.length <= maxStringLength) {
		return value
	}

	return `${value.slice(0, maxStringLength)}…[truncated ${value.length - maxStringLength} chars]`
}

/**
 * Masks credentials in a free-form string. Safe to call on any text, including
 * a full system prompt.
 */
export function redactText(text: string, options: RedactOptions = {}): string {
	const maxStringLength = options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH
	let result = text

	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, REDACTED)
	}

	result = result.replace(URL_CREDENTIALS_PATTERN, (_match, user: string) => `://${user}:${REDACTED}@`)

	result = result.replace(SECRET_ASSIGNMENT_PATTERN, (_match, name: string, quote: string) => {
		return `${name}=${quote}${REDACTED}${quote}`
	})

	for (const secret of options.extraSecrets ?? []) {
		if (secret.length < 6) {
			continue
		}
		result = result.split(secret).join(REDACTED)
	}

	return truncate(result, maxStringLength)
}

/**
 * Semantic alias used by prompt logging. Kept separate so call sites read as
 * intent ("this is a prompt, redact it") rather than as a generic text pass.
 */
export function redactPrompt(prompt: string, options: RedactOptions = {}): string {
	return redactText(prompt, options)
}

/**
 * Deep-redacts a structured payload.
 *
 * Cycles, depth, array length, and object width are all bounded so logging a
 * pathological payload cannot exhaust memory or produce an unreadable record.
 */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
	const seen = new WeakSet<object>()

	const walk = (current: unknown, depth: number, keyHint?: string): unknown => {
		if (keyHint !== undefined && isSensitiveKey(keyHint)) {
			return REDACTED
		}

		if (current === null || current === undefined) {
			return current
		}

		switch (typeof current) {
			case "string":
				return redactText(current, options)
			case "number":
			case "boolean":
				return current
			case "bigint":
				return `${current.toString()}n`
			case "symbol":
			case "function":
				return `[${typeof current}]`
			default:
				break
		}

		if (current instanceof Date) {
			return current.toISOString()
		}

		if (current instanceof Error) {
			return {
				name: current.name,
				message: redactText(current.message, options),
			}
		}

		if (depth >= maxDepth) {
			return "[truncated]"
		}

		if (Array.isArray(current)) {
			const items = current
				.slice(0, options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS)
				.map((item) => walk(item, depth + 1))
			if (current.length > items.length) {
				items.push(`…[truncated ${current.length - items.length} items]`)
			}
			return items
		}

		if (current instanceof Set) {
			return walk([...current], depth, undefined)
		}

		if (current instanceof Map) {
			return walk(Object.fromEntries(current), depth, undefined)
		}

		if (typeof current === "object") {
			// A repeated reference means a cycle in the payload.
			if (seen.has(current)) {
				return "[circular]"
			}
			seen.add(current)

			const entries = Object.entries(current).slice(0, options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS)
			const result: Record<string, unknown> = {}
			for (const [key, entryValue] of entries) {
				result[key] = walk(entryValue, depth + 1, key)
			}
			return result
		}

		return String(current)
	}

	return walk(value, 0)
}

/** Redacts the payload-carrying fields of a record, leaving identity intact. */
export function redactRecord(record: HarnessLogRecord, options: RedactOptions = {}): HarnessLogRecord {
	return {
		...record,
		input: record.input === undefined ? undefined : redactValue(record.input, options),
		result: record.result === undefined ? undefined : redactValue(record.result, options),
		stateBefore: record.stateBefore === undefined ? undefined : redactValue(record.stateBefore, options),
		stateAfter: record.stateAfter === undefined ? undefined : redactValue(record.stateAfter, options),
		attributes:
			record.attributes === undefined
				? undefined
				: (redactValue(record.attributes, options) as Record<string, unknown>),
		reason: record.reason === undefined ? undefined : redactText(record.reason, options),
		error:
			record.error === undefined
				? undefined
				: {
						...record.error,
						message: redactText(record.error.message, options),
						...(record.error.stack ? { stack: redactText(record.error.stack, options) } : {}),
					},
	}
}
