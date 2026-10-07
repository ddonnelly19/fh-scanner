import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OwnedCarInput, OwnershipEvidence } from "../ocr/car-ownership.ts";

export type OwnershipStatus = OwnershipEvidence["status"];
export const ownershipOverridesFile = "ownership-overrides.json";

export function parseOwnershipOverrides(value: unknown): Record<string, OwnershipStatus> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid ownership overrides.");
	const overrides: Record<string, OwnershipStatus> = {};
	for (const [source, status] of Object.entries(value)) {
		if (!/^tiles[\\/]page-\d+-r[1-3]-c[1-5]\.png$/.test(source) ||
			(status !== "owned" && status !== "unowned" && status !== "unknown")) {
			throw new Error(`Invalid ownership override for "${source}".`);
		}
		overrides[source] = status;
	}
	return overrides;
}

export async function loadOwnershipOverrides(directory: string) {
	let content: string;
	try {
		content = await readFile(join(directory, ownershipOverridesFile), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	return parseOwnershipOverrides(JSON.parse(content));
}

export function applyOwnershipOverrides(cars: readonly OwnedCarInput[], overrides: Readonly<Record<string, OwnershipStatus>>): OwnedCarInput[] {
	return cars.map((car) => {
		const status = overrides[car.source];
		return status === undefined ? car : { ...car, ownership: { ...car.ownership, status } };
	});
}
