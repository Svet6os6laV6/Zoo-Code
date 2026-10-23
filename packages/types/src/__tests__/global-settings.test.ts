import {
	DEFAULT_ALWAYS_DENY_UNAPPROVED_COMMANDS,
	DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED,
	DEFAULT_REQUIRE_PLAN_APPROVAL,
	GLOBAL_SETTINGS_KEYS,
	globalSettingsSchema,
} from "../global-settings.js"

describe("destructive command guard global setting", () => {
	it("is opt-in by default", () => {
		expect(DEFAULT_DESTRUCTIVE_COMMAND_GUARD_ENABLED).toBe(false)
	})

	it("accepts and exposes the persisted setting", () => {
		expect(globalSettingsSchema.parse({ destructiveCommandGuardEnabled: true })).toEqual({
			destructiveCommandGuardEnabled: true,
		})
		expect(GLOBAL_SETTINGS_KEYS).toContain("destructiveCommandGuardEnabled")
	})

	it("rejects non-boolean setting values", () => {
		expect(() => globalSettingsSchema.parse({ destructiveCommandGuardEnabled: "true" })).toThrow()
	})
})
describe("requirePlanApproval global setting", () => {
	it("requires plan approval by default", () => {
		expect(DEFAULT_REQUIRE_PLAN_APPROVAL).toBe(true)
	})

	it("accepts and exposes the persisted setting", () => {
		expect(globalSettingsSchema.parse({ requirePlanApproval: false })).toEqual({
			requirePlanApproval: false,
		})
		expect(GLOBAL_SETTINGS_KEYS).toContain("requirePlanApproval")
	})

	it("keeps the setting optional without injecting the default into the schema", () => {
		const parsed = globalSettingsSchema.parse({})

		expect(parsed.requirePlanApproval).toBeUndefined()
	})

	it("rejects non-boolean setting values", () => {
		expect(() => globalSettingsSchema.parse({ requirePlanApproval: "true" })).toThrow()
	})
})

describe("alwaysDenyUnapprovedCommands global setting", () => {
	it("is opt-in by default", () => {
		expect(DEFAULT_ALWAYS_DENY_UNAPPROVED_COMMANDS).toBe(false)
	})

	it("accepts and exposes the persisted setting", () => {
		expect(globalSettingsSchema.parse({ alwaysDenyUnapprovedCommands: true })).toEqual({
			alwaysDenyUnapprovedCommands: true,
		})
		expect(GLOBAL_SETTINGS_KEYS).toContain("alwaysDenyUnapprovedCommands")
	})

	it("rejects non-boolean setting values", () => {
		expect(() => globalSettingsSchema.parse({ alwaysDenyUnapprovedCommands: "true" })).toThrow()
	})
})

describe("collapseCommandOutputByDefault global setting", () => {
	it.each([true, false, undefined])("round-trips %s through the export/import schema", (value) => {
		const settings = globalSettingsSchema.parse({ collapseCommandOutputByDefault: value })
		expect(globalSettingsSchema.parse(JSON.parse(JSON.stringify(settings))).collapseCommandOutputByDefault).toBe(
			value,
		)
		expect(GLOBAL_SETTINGS_KEYS).toContain("collapseCommandOutputByDefault")
	})
	it("rejects non-boolean values", () => {
		expect(globalSettingsSchema.safeParse({ collapseCommandOutputByDefault: "true" }).success).toBe(false)
	})
})
