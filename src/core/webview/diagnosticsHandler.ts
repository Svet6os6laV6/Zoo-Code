import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"
import * as vscode from "vscode"

import { getTaskDirectoryPath } from "../../utils/storage"
import { fileExistsAtPath } from "../../utils/fs"

export interface ErrorDiagnosticsValues {
	timestamp?: string
	version?: string
	provider?: string
	model?: string
	details?: string
}

/**
 * A retained tool failure included in the report. Mirrors the shape returned by
 * `Task#getRecentToolErrors()` without importing the Task module (type-only
 * structural match).
 */
export interface ErrorDiagnosticsToolError {
	tool: string
	error: string
	timestamp: number
}

export interface GenerateDiagnosticsParams {
	taskId: string
	globalStoragePath: string
	values?: ErrorDiagnosticsValues
	/**
	 * Concrete tool failures recorded by the task. The mistake-limit guidance in
	 * `values.details` is generic, so without these the report cannot explain what
	 * the model actually did wrong.
	 */
	toolErrors?: readonly ErrorDiagnosticsToolError[]
	log: (message: string) => void
}

export interface GenerateDiagnosticsResult {
	success: boolean
	filePath?: string
	error?: string
}

/**
 * Generates an error diagnostics file containing error metadata and API conversation history.
 * The file is created in the system temp directory and opened in VS Code for the user to review
 * before sharing with support.
 */
export async function generateErrorDiagnostics(params: GenerateDiagnosticsParams): Promise<GenerateDiagnosticsResult> {
	const { taskId, globalStoragePath, values, toolErrors = [], log } = params

	try {
		const taskDirPath = await getTaskDirectoryPath(globalStoragePath, taskId)

		// Load API conversation history from the same file used by openDebugApiHistory
		const apiHistoryPath = path.join(taskDirPath, "api_conversation_history.json")
		let history: unknown = []

		if (await fileExistsAtPath(apiHistoryPath)) {
			const content = await fs.readFile(apiHistoryPath, "utf8")
			try {
				history = JSON.parse(content)
			} catch {
				// If parsing fails, fall back to empty history but still generate diagnostics file
				vscode.window.showErrorMessage("Failed to parse api_conversation_history.json")
			}
		}

		const diagnostics = {
			error: {
				timestamp: values?.timestamp ?? new Date().toISOString(),
				version: values?.version ?? "",
				provider: values?.provider ?? "",
				model: values?.model ?? "",
				details: values?.details ?? "",
				// Omitted entirely when the task recorded no failures, so reports
				// without tool errors keep their existing shape.
				...(toolErrors.length > 0 ? { toolErrors } : {}),
			},
			history,
		}

		// Prepend human-readable guidance comments before the JSON payload
		const headerComment =
			"// Please share this file with Zoo Code Support (support@zoocode.dev) to diagnose the issue faster\n" +
			"// Just make sure you're OK sharing the contents of the conversation below.\n\n"
		const jsonContent = JSON.stringify(diagnostics, null, 2)
		const fullContent = headerComment + jsonContent

		// Create a temporary diagnostics file
		const tmpDir = os.tmpdir()
		const timestamp = Date.now()
		const tempFileName = `zoo-diagnostics-${taskId.slice(0, 8)}-${timestamp}.json`
		const tempFilePath = path.join(tmpDir, tempFileName)

		await fs.writeFile(tempFilePath, fullContent, "utf8")

		// Open the diagnostics file in VS Code
		const doc = await vscode.workspace.openTextDocument(tempFilePath)
		await vscode.window.showTextDocument(doc, { preview: true })

		return { success: true, filePath: tempFilePath }
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		log(`Error generating diagnostics: ${errorMessage}`)
		vscode.window.showErrorMessage(`Failed to generate diagnostics: ${errorMessage}`)
		return { success: false, error: errorMessage }
	}
}
