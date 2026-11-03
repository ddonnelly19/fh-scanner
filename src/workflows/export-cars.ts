import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { carIdsName, hdrCatalog } from "../catalogs/hdr.ts";
import { formatOrdinalResults, loadCarNameMapping, matchCarText } from "../collection/car-matching.ts";
import type { CapturedCarText } from "../collection/car-matching.ts";

export interface ExportOptions {
	catalogPath?: string;
	mappingPath?: string;
}

export async function exportCarOrdinals(
	cars: readonly CapturedCarText[],
	outputDirectory: string,
	options: ExportOptions = {},
): Promise<{ matched: number; unresolved: number; uniqueNames: number }> {
	const mappingPath = options.mappingPath ?? join(outputDirectory, "car-name-mapping.json");
	const snapshot = await hdrCatalog.load(options.catalogPath);
	const entries = snapshot.entries;
	const mapping = await loadCarNameMapping(mappingPath, entries, carIdsName);
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
	await writeFile(join(outputDirectory, hdrCatalog.snapshotFile), snapshot.content);
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
