import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyOwnership } from "../src/ocr/car-ownership.ts";
import { buildOwnedGaragePlan } from "../src/sites/garage-plan.ts";
import { kudosPrimeAdapter } from "../src/sites/kudosprime/adapter.ts";

test("ownership needs positive rarity evidence; placeholders and uncertainty are never owned", () => {
	for (const label of ["COMMON", "RARE", "EPIC", "LEGENDARY"]) {
		assert.equal(classifyOwnership(label).status, "owned");
	}
	for (const label of ["DISCOVER JAPAN", "JAPAN", "COMMON DISCOVER"]) {
		assert.equal(classifyOwnership(label).status, "unowned");
	}
	for (const label of ["", "CAR", "C0MM0N"]) assert.equal(classifyOwnership(label).status, "unknown");
});

test("garage plan includes only positively owned exact site matches and deduplicates site IDs", () => {
	const entries = [
		{ name: "2002 Acura RSX Type-S", ordinal: "422" },
		{ name: "2002 ACURA RSX TYPE-S", siteIds: { kudosprime: "4" } },
		{ name: "1980 Fiat 131 Abarth Stradale", ordinal: "1124" },
	];
	const owned = { status: "owned" as const, labelText: "COMMON" };
	const plan = buildOwnedGaragePlan([
		{ source: "one", text: "RSX Type S\n2002 Acura", ownership: owned },
		{ source: "two", text: "RSX Type S\n2002 Acura", ownership: owned },
		{ source: "three", text: "RSX Type S\n2002 Acura", ownership: classifyOwnership("DISCOVER JAPAN") },
		{ source: "four", text: "RSX Type S\n2002 Acura", ownership: classifyOwnership("") },
		{ source: "five", text: "Fiat 131\n1980 Abarth", ownership: owned },
	], entries, { "1980 Abarth Fiat 131": "1980 Fiat 131 Abarth Stradale" }, kudosPrimeAdapter);
	assert.deepEqual(plan.owned, [{ id: "4", name: "2002 ACURA RSX TYPE-S", sources: ["one", "two"] }]);
	assert.equal(plan.review.length, 2);
});
