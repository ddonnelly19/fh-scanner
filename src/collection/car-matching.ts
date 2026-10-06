import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { CatalogEntry } from "../catalogs/types.ts";

export const defaultCarMappingPath = fileURLToPath(new URL("../../car-name-mapping.json", import.meta.url));
export interface CarMappingChoices {
	selected: string | null;
	candidates: string[];
}
export type CarNameMapping = Record<string, string | null | CarMappingChoices>;

export function parseCarNameMapping(value: unknown, entries: readonly CatalogEntry[]): CarNameMapping {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Car name mapping must be a JSON object mapping captured names to catalog names or null.");
	}
	const mapping: CarNameMapping = {};
	const isTarget = (target: unknown): target is string | null =>
		target === null || (typeof target === "string" && entries.some((entry) => entry.name === target));
	for (const [capturedName, catalogName] of Object.entries(value)) {
		let parsed: string | null | CarMappingChoices;
		if (typeof catalogName === "object" && catalogName !== null && !Array.isArray(catalogName)) {
			if (!("selected" in catalogName) || !isTarget(catalogName.selected) ||
				!("candidates" in catalogName) || !Array.isArray(catalogName.candidates) ||
				!catalogName.candidates.every((candidate: unknown) => typeof candidate === "string" && isTarget(candidate))) {
				throw new Error(`Invalid car name mapping choices for "${capturedName}".`);
			}
			parsed = { selected: catalogName.selected, candidates: [...catalogName.candidates] };
		} else if (isTarget(catalogName)) {
			parsed = catalogName;
		} else {
			throw new Error(`Invalid car name mapping for "${capturedName}": target must be an exact catalog name or null.`);
		}
		if (!capturedName.trim()) throw new Error("Invalid car name mapping: captured name must not be empty.");
		Object.defineProperty(mapping, capturedName, { value: parsed, enumerable: true, writable: true, configurable: true });
	}
	return mapping;
}

export async function loadCarNameMapping(path: string, entries: readonly CatalogEntry[]): Promise<CarNameMapping> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	const value: unknown = JSON.parse(content);
	return parseCarNameMapping(value, entries);
}

export interface CapturedCarText {
	source: string;
	text: string;
}

export interface CarMatch {
	source: string;
	text: string;
	carName: string | null;
	status: "matched" | "unmatched" | "ambiguous" | "invalid";
	candidates: CatalogEntry[];
}

export function normalizeCarName(value: string): string {
	return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function entryIdentifier(entry: CatalogEntry): string {
	if (entry.ordinal !== undefined) return entry.ordinal;
	const identifiers = Object.entries(entry.siteIds ?? {}).sort(([a], [b]) => a.localeCompare(b));
	if (identifiers.length) return identifiers.map(([site, id]) => `${site}:${id}`).join(",");
	throw new Error(`Catalog entry has no source identifier: ${entry.name}`);
}

export function parseCarText(text: string): string | null {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const yearLines = lines.flatMap((line, index) => /^(?:19|20)\d{2}\s+\S/.test(line) ? [index] : []);
	if (yearLines.length !== 1) return null;
	const yearIndex = yearLines[0]!;
	if (yearIndex === 0) return null;
	const model = lines.slice(0, yearIndex).join(" ");
	const yearAndManufacturer = lines.slice(yearIndex).join(" ");
	return `${yearAndManufacturer} ${model}`;
}

function similarity(left: string, right: string): number {
	const a = normalizeCarName(left);
	const b = normalizeCarName(right);
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const pairs = new Map<string, number>();
	for (let index = 0; index < a.length - 1; index++) {
		const pair = a.slice(index, index + 2);
		pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
	}
	let shared = 0;
	for (let index = 0; index < b.length - 1; index++) {
		const pair = b.slice(index, index + 2);
		const count = pairs.get(pair) ?? 0;
		if (count > 0) {
			shared++;
			pairs.set(pair, count - 1);
		}
	}
	return 2 * shared / (a.length + b.length - 2);
}

export function matchCarText(car: CapturedCarText, entries: readonly CatalogEntry[], mapping: CarNameMapping = {}): CarMatch {
	const carName = parseCarText(car.text);
	if (!carName) return { ...car, carName, status: "invalid", candidates: [] };
	if (Object.hasOwn(mapping, carName)) {
		const value = mapping[carName];
		const target = typeof value === "object" && value !== null ? value.selected : value;
		if (target !== null) {
			const candidates = entries.filter((entry) => entry.name === target);
			if (candidates.length !== 1) throw new Error(`Mapping for "${carName}" does not identify one catalog entry: ${target}`);
			return { ...car, carName, status: "matched", candidates };
		}
		const automatic = matchCarText(car, entries);
		if (automatic.status === "matched" && automatic.candidates.some((entry) => Object.keys(entry.siteIds ?? {}).length > 0)) {
			return automatic;
		}
		return { ...automatic, status: automatic.status === "matched" ? "unmatched" : automatic.status };
	}
	const allExact = entries.filter((entry) => normalizeCarName(entry.name) === normalizeCarName(carName));
	const hdrExact = allExact.filter((entry) => entry.ordinal !== undefined);
	const exact = hdrExact.length ? hdrExact : allExact;
	if (exact.length > 0) {
		const ordinals = new Set(exact.map(entryIdentifier));
		return { ...car, carName, status: ordinals.size === 1 ? "matched" : "ambiguous", candidates: exact };
	}
	// Suggestions never become automatic matches: years and variants can differ across games.
	const year = carName.slice(0, 4);
	const candidates = entries.filter((entry) => entry.name.startsWith(`${year} `))
		.map((entry) => ({ entry, score: similarity(carName, entry.name) }))
		.filter(({ score }) => score >= 0.45)
		.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
		.slice(0, 5).map(({ entry }) => entry);
	return { ...car, carName, status: "unmatched", candidates };
}

export function formatOrdinalResults(matches: readonly CarMatch[]): {
	ordinals: string;
	review: string;
	matched: string;
} {
	const uniqueNames = new Set<string>();
	const matched: string[] = [];
	const review: string[] = [];
	for (const match of matches) {
		if (match.status === "matched") {
			const entry = match.candidates[0];
			if (!entry) throw new Error("Matched car has no catalog entry.");
			uniqueNames.add(entry.name);
			matched.push(`${entryIdentifier(entry)}\t${entry.name}\t${match.source}`);
		} else {
			review.push([
				`[${match.status.toUpperCase()}] ${match.source}`,
				`Car: ${match.carName ?? "[Cannot parse model followed by year/manufacturer]"}`,
				`OCR: ${JSON.stringify(match.text)}`,
				...match.candidates.map((entry) => `Candidate (not accepted): ${entryIdentifier(entry)}\t${entry.name}`),
			].join("\n"));
		}
	}
	const ordinals = [...uniqueNames].sort((a, b) => a.localeCompare(b, "en"));
	return {
		ordinals: ordinals.length ? `${ordinals.join("\n")}\n` : "",
		review: review.length ? `${review.join("\n\n")}\n` : "No unresolved cars.\n",
		matched: matched.length ? `${matched.join("\n")}\n` : "No confirmed matches.\n",
	};
}
