import { matchCarText, normalizeCarName } from "../collection/car-matching.ts";
import type { CarNameMapping } from "../collection/car-matching.ts";
import type { CatalogEntry } from "../catalogs/types.ts";
import type { OwnedCarInput } from "../ocr/car-ownership.ts";
import type { GarageCar, GaragePlanTarget } from "./types.ts";

export function parseGaragePlan(value: unknown, site: GaragePlanTarget): GarageCar[] {
	if (typeof value !== "object" || value === null || !("owned" in value) || !Array.isArray(value.owned)) {
		throw new Error("Garage plan must contain an owned-car array.");
	}
	if ("site" in value ? value.site !== site.id : !site.acceptsLegacyPlan) {
		throw new Error(`Garage plan must target ${site.id}; IDs from other sites cannot be reused.`);
	}
	const ids = new Set<string>();
	return value.owned.map((car: unknown) => {
		if (typeof car !== "object" || car === null ||
			!("id" in car) || typeof car.id !== "string" || !site.isValidCarId(car.id) ||
			!("name" in car) || typeof car.name !== "string" || !car.name.trim() ||
			!("sources" in car) || !Array.isArray(car.sources) || !car.sources.length ||
			!car.sources.every((source: unknown) => typeof source === "string" && source.trim()) || ids.has(car.id)) {
			throw new Error("Garage plan contains an invalid car or duplicate site ID.");
		}
		ids.add(car.id);
		return { id: car.id, name: car.name, sources: [...car.sources] };
	});
}

export function buildOwnedGaragePlan(
	cars: readonly OwnedCarInput[],
	entries: readonly CatalogEntry[],
	mapping: CarNameMapping,
	site: GaragePlanTarget,
): { site: string; owned: GarageCar[]; review: string[] } {
	const byId = new Map<string, GarageCar>();
	const review: string[] = [];
	for (const car of cars) {
		if (car.ownership.status === "unowned") continue;
		if (car.ownership.status === "unknown") {
			review.push(`${car.source}: ownership unknown; label OCR ${JSON.stringify(car.ownership.labelText)}`);
			continue;
		}
		const match = matchCarText(car, entries, mapping);
		if (match.status !== "matched") {
			review.push(`${car.source}: owned but car identity is ${match.status}`);
			continue;
		}
		const target = match.candidates[0]!;
		const siteEntries = entries.filter((entry) => entry.siteIds?.[site.id] !== undefined &&
			normalizeCarName(entry.name) === normalizeCarName(target.name));
		const ids = new Set(siteEntries.map((entry) => entry.siteIds![site.id]!));
		if (ids.size !== 1) {
			review.push(`${car.source}: owned match "${target.name}" has no unique exact ${site.label} name; manual site mapping required`);
			continue;
		}
		const entry = siteEntries[0]!;
		const id = entry.siteIds![site.id]!;
		if (!site.isValidCarId(id)) throw new Error(`Invalid ${site.label} catalog ID: ${id}`);
		const existing = byId.get(id);
		if (existing) existing.sources.push(car.source);
		else byId.set(id, { id, name: entry.name, sources: [car.source] });
	}
	return { site: site.id, owned: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })), review };
}
