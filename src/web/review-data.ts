import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hdrCatalog } from "../catalogs/hdr.ts";
import { defaultCarMappingPath, loadCarNameMapping, matchCarText } from "../collection/car-matching.ts";
import type { OwnedCarInput } from "../ocr/car-ownership.ts";
import { loadOwnershipCatalog } from "../workflows/ownership-input.ts";
import { buildOwnedCars, loadManualMatches, manualMatchesFile, ownedCarsFile, parseManualMatches } from "../workflows/owned-cars.ts";
import { applyOwnershipOverrides, loadOwnershipOverrides, ownershipOverridesFile } from "../workflows/ownership-overrides.ts";
import type { OwnershipStatus } from "../workflows/ownership-overrides.ts";

export function parseOwnershipEvidence(value: unknown): OwnedCarInput[] {
	if (!Array.isArray(value) || !value.length) throw new Error("Ownership evidence must contain captured cars. Run ownership review first.");
	const sources = new Set<string>();
	return value.map((car: unknown) => {
		if (typeof car !== "object" || car === null ||
			!("source" in car) || typeof car.source !== "string" ||
			!/^tiles[\\/]page-\d+-r[1-3]-c[1-5]\.png$/.test(car.source) || sources.has(car.source) ||
			!("text" in car) || typeof car.text !== "string" ||
			!("ownership" in car) || typeof car.ownership !== "object" || car.ownership === null ||
			!("status" in car.ownership) || !["owned", "unowned", "unknown"].includes(String(car.ownership.status)) ||
			!("labelText" in car.ownership) || typeof car.ownership.labelText !== "string") {
			throw new Error("Invalid or duplicate car in ownership evidence.");
		}
		const status = car.ownership.status;
		if (status !== "owned" && status !== "unowned" && status !== "unknown") throw new Error("Invalid ownership status.");
		sources.add(car.source);
		return { source: car.source, text: car.text, ownership: { status, labelText: car.ownership.labelText } };
	});
}

export async function replaceJson(path: string, value: unknown) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function createReviewData(directory: string, mappingPath = defaultCarMappingPath) {
	const inputPaths = [
		mappingPath, join(directory, "ownership-evidence.json"), join(directory, hdrCatalog.snapshotFile),
		join(directory, manualMatchesFile), join(directory, ownershipOverridesFile),
	];
	async function inputContents() {
		return Promise.all(inputPaths.map(async (path) => {
			try { return await readFile(path, "utf8"); }
			catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
				throw error;
			}
		}));
	}
	let expectedInputs = await inputContents();
	async function assertCurrent() {
		const current = await inputContents();
		if (current.some((content, index) => content !== expectedInputs[index])) {
			throw new Error("Local inputs changed outside this dashboard. Reload local files before saving.");
		}
	}
	const entries = await loadOwnershipCatalog(directory);
	const mapping = await loadCarNameMapping(mappingPath, entries);
	const cars = parseOwnershipEvidence(JSON.parse(await readFile(join(directory, "ownership-evidence.json"), "utf8")));
	let manual = await loadManualMatches(directory, entries);
	let overrides = await loadOwnershipOverrides(directory);
	const catalogItems = entries.map((entry) => ({ id: entry.ordinal!, name: entry.name }));
	const owned = () => buildOwnedCars(applyOwnershipOverrides(cars, overrides), entries, mapping, manual, directory);
	const writeOwned = () => replaceJson(join(directory, ownedCarsFile), owned());
	function snapshot() {
		const current = owned();
		const items = applyOwnershipOverrides(cars, overrides).map((car) => {
			const confirmed = current.cars.find((ownedCar) => ownedCar.sources.includes(car.source));
			const match = matchCarText(car, entries);
			return {
				source: car.source,
				text: car.text,
				name: match.carName,
				labelText: car.ownership.labelText,
				ownership: car.ownership.status,
				ownershipOverride: Object.hasOwn(overrides, car.source),
				ocrOwnership: cars.find((original) => original.source === car.source)!.ownership.status,
				selectedId: confirmed ? String(confirmed.ordinal) : null,
				manual: Object.hasOwn(manual, car.source),
				reason: current.review.find((reason) => reason.startsWith(`${car.source}:`)) ?? "",
				suggestions: match.candidates.map((entry) => entry.ordinal!),
			};
		});
		return { directory, catalog: catalogItems, items,
			ownedCount: current.cars.length, reviewCount: current.review.length,
			unknownCount: items.filter((car) => car.ownership === "unknown").length };
	}
	return {
		cars,
		snapshot,
		owned,
		assertCurrent,
		async regenerate() {
			await assertCurrent();
			await writeOwned();
			return snapshot();
		},
		async saveOwnership(source: string, status: OwnershipStatus | null) {
			await assertCurrent();
			if (!cars.some((car) => car.source === source)) throw new Error("Unknown captured tile.");
			if (status !== null && status !== "owned" && status !== "unowned" && status !== "unknown") throw new Error("Invalid ownership classification.");
			const next = { ...overrides };
			if (status === null) delete next[source];
			else next[source] = status;
			await replaceJson(join(directory, ownershipOverridesFile), next);
			overrides = next;
			expectedInputs = await inputContents();
			await writeOwned();
			return snapshot();
		},
		/** Pins a tile to a car by ordinal, or clears the pin with null. */
		async save(source: string, ordinal: string | null) {
			await assertCurrent();
			if (!applyOwnershipOverrides(cars, overrides).some((car) => car.source === source && car.ownership.status === "owned")) {
				throw new Error("Select a captured car with verified owned evidence.");
			}
			const next = { ...manual };
			if (ordinal === null) delete next[source];
			else next[source] = ordinal;
			parseManualMatches({ matches: next }, entries);
			await replaceJson(join(directory, manualMatchesFile), { matches: next });
			manual = next;
			expectedInputs = await inputContents();
			await writeOwned();
			return snapshot();
		},
	};
}
