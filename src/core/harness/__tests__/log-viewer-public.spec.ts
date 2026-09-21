import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { BroadcastSink } from "@roo-code/core"

import { allowNetConnect } from "../../../vitest.setup"

import { createLogViewerServer } from "../log-viewer/server"

allowNetConnect("127.0.0.1")

describe("T03 smoke", () => {
	it("serves the shipped viewer page from log-viewer/public", async () => {
		const logsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "t03-logs-"))
		const publicDirectory = path.join(__dirname, "..", "log-viewer", "public")
		const server = await createLogViewerServer({
			logsDirectory,
			broadcast: new BroadcastSink(),
			activeSessionId: "active",
			publicDirectory,
		})

		try {
			const origin = new URL(server.url).origin

			const page = await fetch(`${origin}/`)
			const html = await page.text()
			expect(html).toContain("Zoo Code Harness Log Viewer")
			expect(html).not.toContain("not bundled yet")

			const script = await fetch(`${origin}/app.js`)
			expect(script.status).toBe(200)
			expect(await script.text()).toContain("EventSource")

			const styles = await fetch(`${origin}/styles.css`)
			expect(styles.status).toBe(200)
			expect(await styles.text()).toContain("#14161a")
		} finally {
			await server.close()
			await fs.rm(logsDirectory, { recursive: true, force: true })
		}
	})
})
