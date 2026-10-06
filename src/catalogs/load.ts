import { readFile } from "node:fs/promises";

export async function readCatalogContent(url: string, label: string, path?: string): Promise<string> {
	if (path !== undefined) return readFile(path, "utf8");
	const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
	if (!response.ok) throw new Error(`${label} catalog download failed: HTTP ${response.status}`);
	return response.text();
}
