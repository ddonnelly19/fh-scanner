import { readCatalogContent } from "../../catalogs/load.ts";
import type { CatalogEntry, CatalogSource } from "../../catalogs/types.ts";

export const kudosCatalogURL = "https://www.kudosprime.com/fh6/fh6_cars_id_names.js";

export function parseKudosCatalog(content: string): CatalogEntry[] {
	// Extract JSON only; never execute downloaded JavaScript.
	const assignment = /fh6\.cars\s*=\s*(\[[\s\S]*\])\s*;?\s*$/.exec(content);
	if (!assignment) throw new Error("KudosPrime catalog does not contain the expected fh6.cars JSON array.");
	const value: unknown = JSON.parse(assignment[1]!);
	if (!Array.isArray(value) || value.length === 0) throw new Error("KudosPrime catalog is empty or invalid.");
	const ids = new Set<string>();
	return value.map((item: unknown) => {
		if (typeof item !== "object" || item === null || !("id" in item) || !("text" in item) ||
			typeof item.id !== "string" || !/^[1-9]\d*$/.test(item.id) ||
			typeof item.text !== "string" || !item.text.trim() || ids.has(item.id)) {
			throw new Error("Invalid or duplicate KudosPrime car entry.");
		}
		ids.add(item.id);
		return { name: item.text, siteIds: { kudosprime: item.id } };
	});
}

export async function loadKudosCatalog(path?: string) {
	const content = await readCatalogContent(kudosCatalogURL, "KudosPrime", path);
	return { entries: parseKudosCatalog(content), content };
}

export const kudosCatalog: CatalogSource = {
	id: "kudosprime",
	snapshotFile: "kudosprime-source.js",
	load: loadKudosCatalog,
};
