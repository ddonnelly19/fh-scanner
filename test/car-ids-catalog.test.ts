import assert from "node:assert/strict";
import { test } from "vitest";
import { migrateCarNameMapping, parseCarNameMapping } from "../src/collection/car-matching.ts";
import { carIdsName, loadOrdinalCatalog, ordinalCatalogFromCarIds, parseOrdinalCatalog } from "../src/catalogs/hdr.ts";
import type { CatalogEntry } from "../src/catalogs/types.ts";

test("builds the ordinal catalog from car-ids names and leaves out names shared by two ordinals", () => {
	assert.deepEqual(ordinalCatalogFromCarIds([
		{ name: "2024 Koenigsegg Gemera", ordinal: 4081 },
		{ name: "2025 GR GT Prototype", ordinal: 4221 },
		{ name: "2025 GR GT Prototype", ordinal: 4263 },
		{ name: "1969 Toyota 2000GT", ordinal: 247 },
		{ name: "1969 Toyota 2000GT", ordinal: 247 },
	]), { "1969 Toyota 2000GT": "247", "2024 Koenigsegg Gemera": "4081" });
});

test("the default ordinal catalog comes from the forzagarage car-ids map", async () => {
	const { entries } = await loadOrdinalCatalog();
	assert.ok(entries.length > 500);
	assert.equal(entries.find((entry) => entry.name === "2024 Koenigsegg Gemera")?.ordinal, "4081");
	assert.equal(carIdsName("1969 Toyota 2000 GT"), "1969 Toyota 2000GT");
});

test("migrates mapping targets to current ordinal names, resetting ones that no longer exist", () => {
	const entries: CatalogEntry[] = [
		...parseOrdinalCatalog({ "1969 Toyota 2000GT": "247", "1954 Mercedes-Benz 300 SL Coupé": "100" }),
		{ name: "1969 TOYOTA 2000GT", siteIds: { kudosprime: "5" } },
		{ name: "2030 Site Only Car", siteIds: { kudosprime: "6" } },
	];
	const renames: Record<string, string> = {
		"1969 Toyota 2000 GT": "1969 Toyota 2000GT",
		"1969 TOYOTA 2000GT": "1969 Toyota 2000GT",
		"1954 Mercedes-Benz 300 SL": "1954 Mercedes-Benz 300 SL Coupé",
	};
	const migrated = migrateCarNameMapping({
		"Toyota old HDR": "1969 Toyota 2000 GT",
		"Toyota kudos": { selected: "1969 TOYOTA 2000GT", candidates: ["1969 TOYOTA 2000GT", "1969 Toyota 2000GT"] },
		"Mercedes": { selected: null, candidates: ["1954 Mercedes-Benz 300 SL", "Gone"] },
		"Site only": "2030 Site Only Car",
		"Gone": "1900 Nothing",
		"Unmatched": null,
	}, entries, (name) => renames[name]);
	assert.deepEqual(parseCarNameMapping(migrated, entries), {
		"Toyota old HDR": "1969 Toyota 2000GT",
		"Toyota kudos": { selected: "1969 Toyota 2000GT", candidates: ["1969 Toyota 2000GT"] },
		"Mercedes": { selected: null, candidates: ["1954 Mercedes-Benz 300 SL Coupé"] },
		"Site only": "2030 Site Only Car",
		"Gone": { selected: null, candidates: [] },
		"Unmatched": null,
	});
});
