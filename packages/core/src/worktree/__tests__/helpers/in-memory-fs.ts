import * as path from "path"

/**
 * Minimal in-memory file system for the artifact parser, validator, and
 * scheduler unit tests. It implements only the capabilities those modules
 * declare, so a test never touches the real disk.
 */
export type InMemoryFileSystem = {
	readFile(filePath: string, encoding: "utf8"): Promise<string>
	readdir(dirPath: string): Promise<string[]>
	writeFile(filePath: string, data: string, encoding: "utf8"): Promise<void>
	rename(oldPath: string, newPath: string): Promise<void>
}

export type InMemoryFileSystemHandle = InMemoryFileSystem & {
	readonly files: Map<string, string>
}

export function createInMemoryFileSystem(initial: Record<string, string> = {}): InMemoryFileSystemHandle {
	const files = new Map(Object.entries(initial))

	return {
		files,
		readFile: async (filePath) => {
			const content = files.get(filePath)
			if (content === undefined) {
				throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" })
			}
			return content
		},
		readdir: async (dirPath) => {
			const prefix = `${dirPath}${path.sep}`
			const entries = [...files.keys()]
				.filter((filePath) => filePath.startsWith(prefix))
				.map((filePath) => filePath.slice(prefix.length))

			if (entries.length === 0) {
				throw Object.assign(new Error(`ENOENT: ${dirPath}`), { code: "ENOENT" })
			}

			return entries
		},
		writeFile: async (filePath, data) => {
			files.set(filePath, data)
		},
		rename: async (oldPath, newPath) => {
			const content = files.get(oldPath)
			if (content === undefined) {
				throw Object.assign(new Error(`ENOENT: ${oldPath}`), { code: "ENOENT" })
			}
			files.delete(oldPath)
			files.set(newPath, content)
		},
	}
}
