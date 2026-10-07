import { readCatalogContent } from "../../catalogs/load.ts";
import type { CatalogEntry, CatalogSource } from "../../catalogs/types.ts";

export const forzaGarageCatalogURL = "https://forzagarage.com/car-tracker/";
const snapshotFormat = "forzagarage-car-tracker";
const idPattern = /^[A-Za-z0-9_-]+$/;

function decodeHtmlEntities(value: string): string {
	return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, code: string) => {
		if (code[0] === "#") {
			const point = code[1]?.toLowerCase() === "x"
				? Number.parseInt(code.slice(2), 16)
				: Number.parseInt(code.slice(1), 10);
			if (!Number.isSafeInteger(point) || point < 0 || point > 0x10ffff) {
				throw new Error("ForzaGarage catalog contains an invalid HTML character reference.");
			}
			return String.fromCodePoint(point);
		}
		switch (code.toLowerCase()) {
			case "amp": return "&";
			case "quot": return "\"";
			case "apos": return "'";
			case "lt": return "<";
			case "gt": return ">";
			default: return entity;
		}
	});
}

function toCatalogEntries(cars: readonly { id: string; name: string }[]): CatalogEntry[] {
	const ids = new Set<string>();
	return cars.map(({ id, name }) => {
		if (!idPattern.test(id) || !name.trim() || ids.has(id)) {
			throw new Error("ForzaGarage catalog contains an invalid or duplicate car entry.");
		}
		ids.add(id);
		return { name, siteIds: { forzagarage: id } };
	});
}

function parseSnapshot(content: string): CatalogEntry[] {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error("ForzaGarage catalog snapshot is not valid JSON.");
	}
	if (typeof value !== "object" || value === null ||
		!("format" in value) || value.format !== snapshotFormat ||
		!("version" in value) || value.version !== 1 ||
		!("cars" in value) || !Array.isArray(value.cars) || !value.cars.length) {
		throw new Error("ForzaGarage catalog snapshot has an unsupported or empty format.");
	}
	const cars = value.cars.map((car: unknown) => {
		if (typeof car !== "object" || car === null ||
			!("id" in car) || typeof car.id !== "string" ||
			!("name" in car) || typeof car.name !== "string") {
			throw new Error("ForzaGarage catalog snapshot contains an invalid car entry.");
		}
		return { id: car.id, name: car.name };
	});
	return toCatalogEntries(cars);
}

function parsePage(content: string): CatalogEntry[] {
	const cars = new Map<string, string>();
	const cells = /<li class="gt-cell" data-id="([^"]+)" data-name="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g;
	for (const match of content.matchAll(cells)) {
		const id = match[1]!;
		const dataName = decodeHtmlEntities(match[2]!);
		const label = /aria-label="([^"]+), toggle unlocked"/.exec(match[3]!)?.[1];
		if (!label) throw new Error(`ForzaGarage catalog car "${id}" has no recognized tracker label.`);
		const name = decodeHtmlEntities(label);
		if (!dataName.trim() || !name.trim()) {
			throw new Error(`ForzaGarage catalog car "${id}" has an empty name.`);
		}
		const existing = cars.get(id);
		if (existing !== undefined && existing !== name) {
			throw new Error(`ForzaGarage catalog has conflicting names for car ID "${id}".`);
		}
		cars.set(id, name);
	}
	if (!cars.size) throw new Error("ForzaGarage catalog page contains no tracker cars.");
	return toCatalogEntries([...cars].map(([id, name]) => ({ id, name })));
}

export function parseForzaGarageCatalog(content: string): CatalogEntry[] {
	return content.trimStart().startsWith("<") ? parsePage(content) : parseSnapshot(content);
}

export async function loadForzaGarageCatalog(path?: string) {
	const source = await readCatalogContent(forzaGarageCatalogURL, "ForzaGarage", path);
	const entries = parseForzaGarageCatalog(source);
	const cars = entries.map((entry) => ({
		id: entry.siteIds!.forzagarage!,
		name: entry.name,
	}));
	const content = `${JSON.stringify({ format: snapshotFormat, version: 1, cars }, null, 2)}\n`;
	return { entries, content };
}

export const forzaGarageCatalog: CatalogSource = {
	id: "forzagarage",
	snapshotFile: "forzagarage-source.json",
	load: loadForzaGarageCatalog,
};
