import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hdrCatalog } from "../catalogs/hdr.ts";
import type { CatalogSource, CatalogEntry } from "../catalogs/types.ts";
import { formatOrdinalResults, loadCarNameMapping, matchCarText } from "../collection/car-matching.ts";
import type { CapturedCarText } from "../collection/car-matching.ts";
import { getSiteAdapter, siteAdapters } from "../sites/registry.ts";

export interface ExportOptions {
	catalogPath?: string;
	mappingPath?: string;
	siteCatalogPaths?: Record<string, string>;
}

export function mergeCatalogEntries(catalogs: readonly (readonly CatalogEntry[])[]): CatalogEntry[] {
	const ambiguousNames = new Set<string>();
	for (const catalog of catalogs) {
		const names = new Set<string>();
		for (const entry of catalog) {
			if (names.has(entry.name)) ambiguousNames.add(entry.name);
			names.add(entry.name);
		}
	}
	const entries: CatalogEntry[] = [];
	for (const catalog of catalogs) {
		for (const entry of catalog) {
			const existing = ambiguousNames.has(entry.name) ? undefined :
				entries.find((candidate) => candidate.name === entry.name);
			if (!existing) {
				entries.push({ ...entry, ...(entry.siteIds ? { siteIds: { ...entry.siteIds } } : {}) });
				continue;
			}
			if (entry.ordinal !== undefined) {
				if (existing.ordinal !== undefined && existing.ordinal !== entry.ordinal) {
					throw new Error(`Conflicting ordinals for "${entry.name}".`);
				}
				existing.ordinal = entry.ordinal;
			}
			for (const [site, id] of Object.entries(entry.siteIds ?? {})) {
				existing.siteIds ??= {};
				if (existing.siteIds[site] !== undefined && existing.siteIds[site] !== id) {
					throw new Error(`Conflicting ${site} IDs for "${entry.name}".`);
				}
				existing.siteIds[site] = id;
			}
		}
	}
	return entries;
}

export async function exportCarOrdinals(
	cars: readonly CapturedCarText[],
	outputDirectory: string,
	options: ExportOptions = {},
): Promise<{ matched: number; unresolved: number; uniqueNames: number }> {
	const mappingPath = options.mappingPath ?? join(outputDirectory, "car-name-mapping.json");
	for (const id of Object.keys(options.siteCatalogPaths ?? {})) getSiteAdapter(id);
	// Supplying only an HDR snapshot retains the original offline workflow.
	const sources: CatalogSource[] = [
		hdrCatalog,
		...siteAdapters.filter((site) => options.catalogPath === undefined ||
			Object.hasOwn(options.siteCatalogPaths ?? {}, site.id)).map((site) => site.catalog),
	];
	const snapshots = await Promise.all(sources.map(async (source) => ({
		source,
		...await source.load(source.id === hdrCatalog.id ? options.catalogPath : options.siteCatalogPaths?.[source.id]),
	})));
	const entries = mergeCatalogEntries(snapshots.map((snapshot) => snapshot.entries));
	const mapping = await loadCarNameMapping(mappingPath, entries);
	const matches = cars.map((car) => matchCarText(car, entries, mapping));
	for (const match of matches) {
		if (match.carName && !Object.hasOwn(mapping, match.carName)) {
			mapping[match.carName] = match.status === "matched" ? match.candidates[0]!.name : {
				selected: null, candidates: match.candidates.map((entry) => entry.name),
			};
		} else if (match.carName && mapping[match.carName] === null) {
			mapping[match.carName] = match.status === "matched" ? match.candidates[0]!.name :
				{ selected: null, candidates: match.candidates.map((entry) => entry.name) };
		} else if (match.carName && match.status === "matched") {
			const value = mapping[match.carName];
			if (typeof value === "object" && value !== null && value.selected === null) {
				value.selected = match.candidates[0]!.name;
			}
		} else if (match.carName && match.status !== "matched") {
			const value = mapping[match.carName];
			if (typeof value === "object" && value !== null && value.selected === null) {
				value.candidates = match.candidates.map((entry) => entry.name);
			}
		}
	}
	const sortedMapping = Object.fromEntries(Object.entries(mapping).sort(([a], [b]) => a.localeCompare(b)));
	await writeFile(mappingPath, `${JSON.stringify(sortedMapping, null, 2)}\n`);
	for (const snapshot of snapshots) {
		await writeFile(join(outputDirectory, snapshot.source.snapshotFile), snapshot.content);
	}
	const formatted = formatOrdinalResults(matches);
	await writeFile(join(outputDirectory, "ordinals.txt"), formatted.ordinals);
	await writeFile(join(outputDirectory, "ordinal-review.txt"), formatted.review);
	await writeFile(join(outputDirectory, "ordinal-matches.txt"), formatted.matched);
	return {
		matched: matches.filter((match) => match.status === "matched").length,
		unresolved: matches.filter((match) => match.status !== "matched").length,
		uniqueNames: formatted.ordinals.trim() ? formatted.ordinals.trim().split("\n").length : 0,
	};
}
