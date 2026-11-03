import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogEntry } from "../catalogs/types.ts";
import { matchCarText } from "../collection/car-matching.ts";
import type { CarNameMapping } from "../collection/car-matching.ts";
import type { OwnedCarInput } from "../ocr/car-ownership.ts";

/**
 * The scan's result: owned cars as FH6 ordinals. forzagarage's collection-sync reads this file and
 * marks the cars owned on ForzaLabs, ForzaGarage or KudosPrime.
 */
export const ownedCarsFile = "owned-cars.json";
/** Per-tile car picks made in the dashboard: `{ "matches": { "<tile>": "<ordinal>" } }`. */
export const manualMatchesFile = "car-matches.json";

export interface OwnedCar {
	ordinal: number;
	name: string;
	sources: string[];
}

export interface OwnedCarList {
	format: "fh-owned-cars";
	version: 1;
	source: string;
	cars: OwnedCar[];
	review: string[];
}

const tilePattern = /^tiles[\\/]page-\d+-r[1-3]-c[1-5]\.png$/;

export function parseManualMatches(value: unknown, entries: readonly CatalogEntry[]): Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value) ||
		!("matches" in value) || typeof value.matches !== "object" || value.matches === null || Array.isArray(value.matches)) {
		throw new Error("Invalid manual car matches file.");
	}
	const matches: Record<string, string> = {};
	for (const [source, ordinal] of Object.entries(value.matches)) {
		if (!tilePattern.test(source) || typeof ordinal !== "string" || !entries.some((entry) => entry.ordinal === ordinal)) {
			throw new Error(`Invalid manual car match for "${source}".`);
		}
		matches[source] = ordinal;
	}
	return matches;
}

export async function loadManualMatches(directory: string, entries: readonly CatalogEntry[]): Promise<Record<string, string>> {
	let content: string;
	try {
		content = await readFile(join(directory, manualMatchesFile), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	return parseManualMatches(JSON.parse(content), entries);
}

/** Owned tiles become ordinals: a manual pick first, then the name match. Anything uncertain goes to review. */
export function buildOwnedCars(
	cars: readonly OwnedCarInput[],
	entries: readonly CatalogEntry[],
	mapping: CarNameMapping,
	manual: Readonly<Record<string, string>>,
	source: string,
): OwnedCarList {
	const byOrdinal = new Map<string, OwnedCar>();
	const review: string[] = [];
	const add = (entry: CatalogEntry, tile: string) => {
		const ordinal = entry.ordinal!;
		const existing = byOrdinal.get(ordinal);
		if (existing) existing.sources.push(tile);
		else byOrdinal.set(ordinal, { ordinal: Number(ordinal), name: entry.name, sources: [tile] });
	};
	for (const car of cars) {
		if (car.ownership.status === "unowned") continue;
		if (car.ownership.status === "unknown") {
			review.push(`${car.source}: ownership unknown; label OCR ${JSON.stringify(car.ownership.labelText)}`);
			continue;
		}
		const picked = manual[car.source];
		if (picked !== undefined) {
			const entry = entries.find((candidate) => candidate.ordinal === picked);
			if (!entry) throw new Error(`Manual match for "${car.source}" names unknown ordinal ${picked}.`);
			add(entry, car.source);
			continue;
		}
		const match = matchCarText(car, entries, mapping);
		const entry = match.candidates[0];
		if (match.status !== "matched" || entry?.ordinal === undefined) {
			review.push(`${car.source}: owned but car identity is ${match.status}`);
			continue;
		}
		add(entry, car.source);
	}
	return {
		format: "fh-owned-cars",
		version: 1,
		source,
		cars: [...byOrdinal.values()].sort((a, b) => a.name.localeCompare(b.name, "en")),
		review,
	};
}
