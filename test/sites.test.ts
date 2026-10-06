import assert from "node:assert/strict";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { defaultCarMappingPath, formatOrdinalResults, matchCarText } from "../src/collection/car-matching.ts";
import { buildOwnedGaragePlan, parseGaragePlan } from "../src/sites/garage-plan.ts";
import { applyGaragePlan } from "../src/sites/apply-plan.ts";
import type { SyncResult } from "../src/sites/apply-plan.ts";
import type { GaragePlanTarget } from "../src/sites/types.ts";
import { getSiteAdapter } from "../src/sites/registry.ts";
import { kudosPrimeAdapter } from "../src/sites/kudosprime/adapter.ts";
import { mergeCatalogEntries } from "../src/workflows/export-cars.ts";

const exampleSite: GaragePlanTarget = {
	id: "example",
	label: "Example",
	acceptsLegacyPlan: false,
	isValidCarId: (id) => /^car-[a-z]+$/.test(id),
};

test("site selection is explicit and unsupported sites never fall back to KudosPrime", () => {
	assert.equal(getSiteAdapter("kudosprime"), kudosPrimeAdapter);
	for (const site of ["", "labsgg", "forzagarage", "fhstats"]) {
		assert.throws(() => getSiteAdapter(site), /Unsupported site/);
	}
	assert.doesNotThrow(() => kudosPrimeAdapter.assertReady("https://www.kudosprime.com/fh6/carlist.php"));
	assert.throws(() => kudosPrimeAdapter.assertReady("https://www.kudosprime.com.example.com/"));
});

test("default mapping stays in the project root regardless of the runner working directory", () => {
	const expectedPath = fileURLToPath(new URL("../car-name-mapping.json", import.meta.url));
	const originalDirectory = process.cwd();
	try {
		process.chdir(fileURLToPath(new URL("../src", import.meta.url)));
		assert.equal(defaultCarMappingPath, expectedPath);
	} finally {
		process.chdir(originalDirectory);
	}
});

test("site-bound plans reject cross-site IDs and only KudosPrime accepts its old untagged plans", () => {
	const car = { id: "car-acura", name: "2002 Acura RSX Type-S", sources: ["one"] };
	assert.deepEqual(parseGaragePlan({ site: "example", owned: [car] }, exampleSite), [car]);
	assert.throws(() => parseGaragePlan({ owned: [car] }, exampleSite), /must target example/);
	assert.throws(() => parseGaragePlan({ site: "kudosprime", owned: [car] }, exampleSite), /must target example/);
	assert.throws(() => parseGaragePlan({ site: "example", owned: [{ ...car, id: "4" }] }, exampleSite), /invalid car/);
	assert.throws(() => parseGaragePlan({ site: "example", owned: [] }, kudosPrimeAdapter), /must target kudosprime/);
});

test("owned planning uses only the target site's IDs, supports nonnumeric IDs, and excludes ambiguity", () => {
	const entries = [
		{ name: "2002 Acura RSX Type-S", ordinal: "422", siteIds: { kudosprime: "4", example: "car-acura" } },
		{ name: "2001 Acura Integra Type R", ordinal: "368", siteIds: { kudosprime: "5" } },
	];
	const cars = [
		{ source: "one", text: "RSX Type S\n2002 Acura", ownership: { status: "owned" as const, labelText: "COMMON" } },
		{ source: "two", text: "RSX Type S\n2002 Acura", ownership: { status: "owned" as const, labelText: "EPIC" } },
		{ source: "three", text: "Integra Type R\n2001 Acura", ownership: { status: "owned" as const, labelText: "COMMON" } },
		{ source: "four", text: "RSX Type S\n2002 Acura", ownership: { status: "unknown" as const, labelText: "" } },
	];
	const plan = buildOwnedGaragePlan(cars, entries, {}, exampleSite);
	assert.equal(plan.site, "example");
	assert.deepEqual(plan.owned, [{ id: "car-acura", name: entries[0]!.name, sources: ["one", "two"] }]);
	assert.equal(plan.review.length, 2);
	assert.deepEqual(parseGaragePlan(plan, exampleSite), plan.owned);
	const ambiguous = buildOwnedGaragePlan(cars.slice(0, 1), [
		...entries, { name: "2002 ACURA RSX TYPE-S", siteIds: { example: "car-other" } },
	], {}, exampleSite);
	assert.equal(ambiguous.owned.length, 0);
	assert.match(ambiguous.review[0]!, /no unique exact Example name/);
});

test("catalog merging retains independent IDs and ordinals without mutating inputs or hiding conflicts", () => {
	const hdr = { name: "2002 Acura RSX Type-S", ordinal: "422" };
	const kudos = { name: hdr.name, siteIds: { kudosprime: "4" } };
	const other = { name: hdr.name, siteIds: { example: "car-acura" } };
	const merged = mergeCatalogEntries([[hdr], [kudos], [other]]);
	assert.deepEqual(merged, [{ ...hdr, siteIds: { kudosprime: "4", example: "car-acura" } }]);
	assert.deepEqual(kudos.siteIds, { kudosprime: "4" });
	assert.deepEqual(other.siteIds, { example: "car-acura" });
	assert.throws(() => mergeCatalogEntries([[hdr], [{ ...hdr, ordinal: "999" }]]), /Conflicting ordinals/);
	assert.throws(() => mergeCatalogEntries([[kudos], [{ name: hdr.name, siteIds: { kudosprime: "999" } }]]), /Conflicting kudosprime/);
	const siteOnly = matchCarText({ source: "one", text: "RSX Type S\n2002 Acura" }, [other]);
	assert.equal(siteOnly.status, "matched");
	assert.match(formatOrdinalResults([siteOnly]).matched, /^example:car-acura\t/);
	const pending = matchCarText({ source: "one", text: "RSX Type S\n2002 Acura" }, [other], { "2002 Acura RSX Type S": null });
	assert.equal(pending.status, "matched");
});

test("shared sync writes uncertainty before each request, confirms afterward and rate-limits sequentially", async () => {
	const cars = [
		{ id: "car-a", name: "A", sources: ["one"] },
		{ id: "car-b", name: "B", sources: ["two"] },
	];
	const events: string[] = [];
	const results = await applyGaragePlan(cars, 500, {
		persist: async (results) => { events.push(`save:${results.map((result) => result.status).join(",")}`); },
		addOwned: async (car) => { events.push(`add:${car.id}`); },
		onConfirmed: (car) => { events.push(`confirmed:${car.id}`); },
		wait: async (ms) => { events.push(`wait:${ms}`); },
	});
	assert.deepEqual(events, [
		"save:uncertain", "add:car-a", "save:confirmed", "confirmed:car-a", "wait:500",
		"save:confirmed,uncertain", "add:car-b", "save:confirmed,confirmed", "confirmed:car-b", "wait:500",
	]);
	assert.deepEqual(results.map((result) => result.status), ["confirmed", "confirmed"]);
});

test("shared sync stops on failure, persists uncertainty, and never retries or sends later cars", async () => {
	const cars = ["a", "b", "c"].map((id) => ({ id, name: id, sources: ["one"] }));
	const attempted: string[] = [];
	let persisted: readonly SyncResult[] = [];
	await assert.rejects(applyGaragePlan(cars, 500, {
		persist: async (results) => { persisted = structuredClone(results); },
		addOwned: async (car) => {
			attempted.push(car.id);
			if (car.id === "b") throw new Error("Session expired");
		},
		onConfirmed: () => {},
		wait: async () => {},
	}), /Session expired/);
	assert.deepEqual(attempted, ["a", "b"]);
	assert.deepEqual(persisted.map((result) => result.status), ["confirmed", "uncertain"]);
	await assert.rejects(applyGaragePlan(cars, 500, {
		persist: async () => { throw new Error("Disk full"); },
		addOwned: async () => { assert.fail("must not update when audit cannot be saved"); },
		onConfirmed: () => {},
		wait: async () => {},
	}), /Disk full/);
});
