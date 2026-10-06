import { readCatalogContent } from "./load.ts";
import type { CatalogEntry, CatalogSource } from "./types.ts";

export const ordinalCatalogURL = "https://gist.githubusercontent.com/HDR/fe980cb41c64bdc264dca7bd8c9cdfdc/raw/Forza-Car-Ordinals-Masterlist.json";

export function parseOrdinalCatalog(value: unknown): CatalogEntry[] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Ordinal catalog must be a JSON object mapping car names to ordinal numbers.");
	}
	const entries: CatalogEntry[] = [];
	for (const [name, ordinal] of Object.entries(value)) {
		if (!name.trim() || typeof ordinal !== "string" || !/^[1-9]\d*$/.test(ordinal) ||
			!Number.isSafeInteger(Number(ordinal))) {
			throw new Error(`Invalid ordinal catalog entry: ${name}`);
		}
		entries.push({ name, ordinal });
	}
	if (entries.length === 0) throw new Error("Ordinal catalog is empty.");
	return entries;
}

export async function loadOrdinalCatalog(path?: string) {
	const content = await readCatalogContent(ordinalCatalogURL, "Ordinal", path);
	const value: unknown = JSON.parse(content);
	return { entries: parseOrdinalCatalog(value), content };
}

export const hdrCatalog: CatalogSource = {
	id: "hdr",
	snapshotFile: "car-ordinals-source.json",
	load: loadOrdinalCatalog,
};
