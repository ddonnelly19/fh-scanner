import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyOwnership } from "../src/ocr/car-ownership.ts";
import { buildOwnedCars, parseManualMatches } from "../src/workflows/owned-cars.ts";

test("ownership needs positive rarity evidence; placeholders and uncertainty are never owned", () => {
	for (const label of ["COMMON", "RARE", "EPIC", "LEGENDARY"]) {
		assert.equal(classifyOwnership(label).status, "owned");
	}
	for (const label of ["DISCOVER JAPAN", "JAPAN", "COMMON DISCOVER"]) {
		assert.equal(classifyOwnership(label).status, "unowned");
	}
	for (const label of ["", "CAR", "C0MM0N"]) assert.equal(classifyOwnership(label).status, "unknown");
});

const entries = [
	{ name: "2002 Acura RSX Type-S", ordinal: "422" },
	{ name: "1980 Fiat 131 Abarth Stradale", ordinal: "1124" },
	{ name: "2007 Alfa Romeo 8C Competizione", ordinal: "1" },
];
const owned = { status: "owned" as const, labelText: "COMMON" };

test("owned list holds only positively owned cars, as ordinals, one entry per car", () => {
	const list = buildOwnedCars([
		{ source: "one", text: "RSX Type S\n2002 Acura", ownership: owned },
		{ source: "two", text: "RSX Type S\n2002 Acura", ownership: owned },
		{ source: "three", text: "RSX Type S\n2002 Acura", ownership: classifyOwnership("DISCOVER JAPAN") },
		{ source: "four", text: "RSX Type S\n2002 Acura", ownership: classifyOwnership("") },
		{ source: "five", text: "Fiat 131\n1980 Abarth", ownership: owned },
		{ source: "six", text: "Mystery\n1999 Nobody", ownership: owned },
		{ source: "seven", text: "unreadable", ownership: owned },
	], entries, { "1980 Abarth Fiat 131": "1980 Fiat 131 Abarth Stradale" }, { seven: "1" }, "scan-x");
	assert.deepEqual(list.cars, [
		{ ordinal: 1124, name: "1980 Fiat 131 Abarth Stradale", sources: ["five"] },
		{ ordinal: 422, name: "2002 Acura RSX Type-S", sources: ["one", "two"] },
		{ ordinal: 1, name: "2007 Alfa Romeo 8C Competizione", sources: ["seven"] },
	]);
	assert.equal(list.format, "fh-owned-cars");
	assert.equal(list.source, "scan-x");
	assert.deepEqual(list.review.map((reason) => reason.split(":")[0]), ["four", "six"]);
});

test("manual matches name a tile and a known ordinal", () => {
	assert.deepEqual(parseManualMatches({ matches: { "tiles/page-001-r1-c1.png": "422" } }, entries), { "tiles/page-001-r1-c1.png": "422" });
	assert.throws(() => parseManualMatches({ matches: { "tiles/page-001-r1-c1.png": "999" } }, entries), /Invalid manual/);
	assert.throws(() => parseManualMatches({ matches: { "../secret": "422" } }, entries), /Invalid manual/);
	assert.throws(() => parseManualMatches({ site: "kudosprime" }, entries), /Invalid manual/);
});
