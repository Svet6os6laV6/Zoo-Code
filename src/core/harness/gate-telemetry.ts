/**
 * Gate rejection telemetry.
 *
 * The gate decisions themselves are pure (see `lifecycle-gate.ts`); this module
 * is the single enforcement-side emitter for `harness.gate.rejected`, so every
 * gate rejection — the existing launch/artifact-mutation gates and the
 * stage-mode-switch/unit-mutation gates — is recorded with the same shape and
 * level. Emitting is best-effort: observability must never break tool
 * execution, so a failed context resolution or a throwing sink is swallowed.
 */

import { harnessLogger, type HarnessLogContextInput } from "@roo-code/core"

import { HARNESS_GATE_REJECTED_EVENT, type HarnessGateName } from "./lifecycle-gate"

/**
 * Emit a `harness.gate.rejected` warn record for a rejected gate.
 *
 * `getContext` is resolved lazily so a task without a harness context (ordinary
 * work outside harness tasks) does not fail the caller.
 */
export async function emitGateRejected(
	getContext: () => Promise<HarnessLogContextInput>,
	gate: HarnessGateName,
	reason: string,
): Promise<void> {
	try {
		harnessLogger().event(HARNESS_GATE_REJECTED_EVENT, {
			level: "warn",
			context: await getContext(),
			attributes: { gate, reason },
		})
	} catch {
		// Observability must never break tool execution.
	}
}
