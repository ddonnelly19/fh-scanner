import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogEntry } from "../catalogs/types.ts";
import type { GaragePlanTarget } from "../sites/types.ts";

export function siteMappingPath(directory: string, site: GaragePlanTarget): string {
	return join(directory, `${site.id}-car-mapping.json`);
}

export function parseSiteMapping(value: unknown, site: GaragePlanTarget, entries: readonly CatalogEntry[]): Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value) ||
		!("site" in value) || value.site !== site.id ||
		!("matches" in value) || typeof value.matches !== "object" || value.matches === null || Array.isArray(value.matches)) {
		throw new Error(`Invalid ${site.label} manual mapping file.`);
	}
	const matches: Record<string, string> = {};
	for (const [source, id] of Object.entries(value.matches)) {
		if (!/^tiles[\\/]page-\d+-r[1-3]-c[1-5]\.png$/.test(source) || typeof id !== "string" ||
			!site.isValidCarId(id) || entries.filter((entry) => entry.siteIds?.[site.id] === id).length !== 1) {
			throw new Error(`Invalid ${site.label} manual mapping for "${source}".`);
		}
		matches[source] = id;
	}
	return matches;
}

export async function loadSiteMapping(directory: string, site: GaragePlanTarget, entries: readonly CatalogEntry[]) {
	let content: string;
	try {
		content = await readFile(siteMappingPath(directory, site), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	return parseSiteMapping(JSON.parse(content), site, entries);
}
