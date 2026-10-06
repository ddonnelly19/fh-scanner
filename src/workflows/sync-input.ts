import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readSyncPlan(directory: string, planFile: string, siteId: string): Promise<unknown> {
	let content: string;
	try {
		content = await readFile(join(directory, planFile), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new Error(
				`Ownership plan missing for selected run: ${directory}\n` +
				`Generate it with: npm run ownership -- --run-dir "${directory}" --site ${siteId}\n` +
				"Review the evidence and plan, then rerun sync. No account updates sent.",
			);
		}
		throw error;
	}
	return JSON.parse(content);
}
