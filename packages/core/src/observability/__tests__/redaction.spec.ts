import { REDACTED, isSensitiveKey, redactPrompt, redactRecord, redactText, redactValue } from "../redaction.js"
import type { HarnessLogRecord } from "../types.js"

describe("redactText", () => {
	it("masks provider-style API keys", () => {
		expect(redactText("key=sk-abcdefghijklmnopqrstuvwxyz")).toBe(`key=${REDACTED}`)
		expect(redactText("token sk-or-v1-abcdefghijklmnopqrstuvwxyz")).toBe(`token ${REDACTED}`)
		expect(redactText("ghp_abcdefghijklmnopqrstuvwxyz01")).toBe(REDACTED)
		expect(redactText("AIzaSyA1234567890abcdefghijklmnopq")).toBe(REDACTED)
	})

	it("masks bearer tokens and JWTs", () => {
		expect(redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")).toBe(`Authorization: ${REDACTED}`)
		expect(redactText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g")).toBe(
			REDACTED,
		)
	})

	it("masks private key blocks", () => {
		const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"
		expect(redactText(`before ${block} after`)).toBe(`before ${REDACTED} after`)
	})

	it("keeps the user name but masks the password in a URL", () => {
		expect(redactText("https://user:s3cretpassword@example.test/repo.git")).toBe(
			`https://user:${REDACTED}@example.test/repo.git`,
		)
	})

	it("masks credential-looking environment assignments", () => {
		expect(redactText("OPENAI_API_KEY=sk-abcdefghijklmnop\nOTHER=value")).toBe(
			`OPENAI_API_KEY=${REDACTED}\nOTHER=value`,
		)
		expect(redactText("DB_PASSWORD: hunter2hunter2")).toBe(`DB_PASSWORD=${REDACTED}`)
	})

	it("masks extra secrets supplied by the caller", () => {
		expect(redactText("value is super-secret-value here", { extraSecrets: ["super-secret-value"] })).toBe(
			`value is ${REDACTED} here`,
		)
	})

	it("truncates long text", () => {
		const result = redactText("a".repeat(50), { maxStringLength: 10 })
		expect(result.startsWith("a".repeat(10))).toBe(true)
		expect(result).toContain("[truncated 40 chars]")
	})

	it("leaves ordinary text untouched", () => {
		expect(redactText("Status: IMPLEMENTATION\nCurrent Task: implementation/T02-worker.md")).toBe(
			"Status: IMPLEMENTATION\nCurrent Task: implementation/T02-worker.md",
		)
	})
})

describe("redactPrompt", () => {
	it("is the prompt-facing alias of redactText", () => {
		expect(redactPrompt("api key sk-abcdefghijklmnopqrstuvwxyz")).toBe(`api key ${REDACTED}`)
	})
})

describe("isSensitiveKey", () => {
	it("recognizes credential key names regardless of separators", () => {
		expect(isSensitiveKey("apiKey")).toBe(true)
		expect(isSensitiveKey("api_key")).toBe(true)
		expect(isSensitiveKey("OPENAI_API_KEY")).toBe(true)
		expect(isSensitiveKey("refresh-token")).toBe(true)
		expect(isSensitiveKey("clientSecret")).toBe(true)
		expect(isSensitiveKey("status")).toBe(false)
		expect(isSensitiveKey("currentTask")).toBe(false)
	})
})

describe("redactValue", () => {
	it("masks sensitive keys at any depth", () => {
		const result = redactValue({ provider: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz", model: "gpt" } })
		expect(result).toEqual({ provider: { apiKey: REDACTED, model: "gpt" } })
	})

	it("masks secrets embedded in string values", () => {
		expect(redactValue({ note: "use sk-abcdefghijklmnopqrstuvwxyz" })).toEqual({ note: `use ${REDACTED}` })
	})

	it("handles cycles without recursing forever", () => {
		const cyclic: Record<string, unknown> = { name: "root" }
		cyclic.self = cyclic

		expect(redactValue(cyclic)).toEqual({ name: "root", self: "[circular]" })
	})

	it("bounds depth, array length, and object width", () => {
		expect(redactValue({ a: { b: { c: { d: 1 } } } }, { maxDepth: 2 })).toEqual({ a: { b: "[truncated]" } })
		expect(redactValue([1, 2, 3, 4], { maxArrayItems: 2 })).toEqual([1, 2, "…[truncated 2 items]"])
		expect(redactValue({ a: 1, b: 2, c: 3 }, { maxObjectKeys: 2 })).toEqual({ a: 1, b: 2 })
	})

	it("normalizes non-JSON values", () => {
		expect(redactValue(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z")
		expect(redactValue(new Error("boom"))).toEqual({ name: "Error", message: "boom" })
		expect(redactValue(10n)).toBe("10n")
		expect(redactValue(new Set(["a"]))).toEqual(["a"])
	})
})

describe("redactRecord", () => {
	it("redacts payload fields and keeps identity intact", () => {
		const record: HarnessLogRecord = {
			kind: "decision",
			name: "harness.task.resolve",
			level: "info",
			timestamp: "2026-01-01T00:00:00.000Z",
			context: { traceId: "t", sessionId: "s", taskId: "SITESUP-1116", txxId: null, mode: "code" },
			input: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz" },
			result: { taskId: "SITESUP-1116" },
			reason: "resolved with sk-abcdefghijklmnopqrstuvwxyz",
			attributes: { token: "ghp_abcdefghijklmnopqrstuvwxyz01" },
			error: { name: "Error", message: "failed with sk-abcdefghijklmnopqrstuvwxyz" },
		}

		const redacted = redactRecord(record)

		expect(redacted.name).toBe("harness.task.resolve")
		expect(redacted.context.taskId).toBe("SITESUP-1116")
		expect(redacted.input).toEqual({ apiKey: REDACTED })
		expect(redacted.result).toEqual({ taskId: "SITESUP-1116" })
		expect(redacted.reason).toBe(`resolved with ${REDACTED}`)
		expect(redacted.attributes).toEqual({ token: REDACTED })
		expect(redacted.error?.message).toBe(`failed with ${REDACTED}`)
	})
})
