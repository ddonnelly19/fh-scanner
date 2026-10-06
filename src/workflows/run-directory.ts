import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const defaultScreenshotsDirectory = fileURLToPath(new URL("../../screenshots", import.meta.url));

export async function resolveRunDirectory(
	runDirectory?: string,
	screenshotsDirectory: string = defaultScreenshotsDirectory,
): Promise<string> {
	if (runDirectory !== undefined) {
		if (!runDirectory.trim()) throw new Error("--run-dir must not be empty.");
		return resolve(runDirectory);
	}
	let directories;
	try {
		directories = await readdir(screenshotsDirectory, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new Error("No saved scans found. Capture a run first or supply --run-dir.");
		}
		throw error;
	}
	const runs = await Promise.all(directories
		.filter((entry) => entry.isDirectory() && entry.name.startsWith("scan-"))
		.map(async (entry) => {
			const path = join(screenshotsDirectory, entry.name);
			return { path, created: (await stat(path)).birthtimeMs };
		}));
	runs.sort((a, b) => b.created - a.created || a.path.localeCompare(b.path));
	if (!runs.length) throw new Error("No saved scans found. Capture a run first or supply --run-dir.");
	return resolve(runs[0]!.path);
}
