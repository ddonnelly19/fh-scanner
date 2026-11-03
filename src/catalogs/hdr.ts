import { readFile } from "node:fs/promises";
import { CarIdIndex, loadCarIdData } from "@forzagarage/car-ids";
import type { CarIdRecord } from "@forzagarage/car-ids";
import type { CatalogEntry, CatalogSource } from "./types.ts";

/**
 * FH6 car names keyed to the game's ordinal, as a `{ "<full name>": "<ordinal>" }` object.
 * Names come from the forzagarage project's car-ids map (ForzaGarage's in-game names). A name
 * shared by two ordinals is left out so it goes to review instead of guessing.
 */
export function ordinalCatalogFromCarIds(cars: readonly Pick<CarIdRecord, "name" | "ordinal">[]): Record<string, string> {
	const ordinals = new Map<string, Set<number>>();
	for (const { name, ordinal } of cars) {
		if (!ordinals.has(name)) ordinals.set(name, new Set());
		ordinals.get(name)!.add(ordinal);
	}
	return Object.fromEntries([...ordinals]
		.filter(([, values]) => values.size === 1)
		.map(([name, values]) => [name, String([...values][0])] as const)
		.sort(([a], [b]) => a.localeCompare(b, "en")));
}

let carIdIndex: CarIdIndex | undefined;

/** The car-ids name for any known spelling of a car (HDR, ForzaLabs, FHStats, short name), if there is one. */
export function carIdsName(name: string): string | undefined {
	carIdIndex ??= CarIdIndex.load();
	return carIdIndex.byName(name)?.name;
}

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

/** Reads a saved ordinal snapshot, or builds one from the car-ids map when no path is given. */
export async function loadOrdinalCatalog(path?: string) {
	const content = path !== undefined ? await readFile(path, "utf8") :
		`${JSON.stringify(ordinalCatalogFromCarIds(loadCarIdData().cars), null, 1)}\n`;
	const value: unknown = JSON.parse(content);
	return { entries: parseOrdinalCatalog(value), content };
}

export const hdrCatalog: CatalogSource = {
	id: "hdr",
	snapshotFile: "car-ordinals-source.json",
	load: loadOrdinalCatalog,
};
