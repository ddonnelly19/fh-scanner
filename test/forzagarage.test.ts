import assert from "node:assert/strict";
import { test } from "vitest";
import { buildOwnedGaragePlan } from "../src/sites/garage-plan.ts";
import { parseForzaGarageCatalog } from "../src/sites/forzagarage/catalog.ts";
import { forzaGarageAdapter } from "../src/sites/forzagarage/adapter.ts";
import { getSiteAdapter } from "../src/sites/registry.ts";
import { mergeCatalogEntries } from "../src/workflows/export-cars.ts";

const trackerPage = `
<li class="gt-cell" data-id="ACU_RSX_02" data-name="2002 acura rsx type-s">
  <div class="car-card" aria-label="2002 Acura RSX Type-S, toggle unlocked"></div>
</li>
<li class="gt-cell" data-id="FER_F50_95" data-name="1995 ferrari f50">
  <div class="car-card" aria-label="1995 Ferrari F50, toggle unlocked"></div>
</li>
<li class="gt-cell" data-id="ACU_RSX_02" data-name="2002 acura rsx type-s">
  <div class="car-card" aria-label="2002 Acura RSX Type-S, toggle unlocked"></div>
</li>`;

test("ForzaGarage catalog parses unique tracker IDs and tolerates repeated views", () => {
	const entries = parseForzaGarageCatalog(trackerPage);
	assert.deepEqual(entries, [
		{ name: "2002 Acura RSX Type-S", siteIds: { forzagarage: "ACU_RSX_02" } },
		{ name: "1995 Ferrari F50", siteIds: { forzagarage: "FER_F50_95" } },
	]);
});

test("ForzaGarage catalog decodes names and replays compact snapshots", () => {
	const html = trackerPage.replace("Type-S", "Type&#45;S").replace("Type-S", "Type&#45;S");
	assert.equal(parseForzaGarageCatalog(html)[0]!.name, "2002 Acura RSX Type-S");
	const snapshot = JSON.stringify({
		format: "forzagarage-car-tracker",
		version: 1,
		cars: [{ id: "ACU_RSX_02", name: "2002 Acura RSX Type-S" }],
	});
	assert.deepEqual(parseForzaGarageCatalog(snapshot), [
		{ name: "2002 Acura RSX Type-S", siteIds: { forzagarage: "ACU_RSX_02" } },
	]);
});

test("ForzaGarage catalog rejects empty, malformed and conflicting data", () => {
	assert.throws(() => parseForzaGarageCatalog("<html></html>"), /no tracker cars/);
	assert.throws(() => parseForzaGarageCatalog(trackerPage.replace("ACU_RSX_02", "bad/id")), /invalid or duplicate/);
	assert.throws(() => parseForzaGarageCatalog(trackerPage.replace(
		"2002 Acura RSX Type-S, toggle unlocked",
		"2001 Acura RSX Type-S, toggle unlocked",
	)), /conflicting names/);
	assert.throws(() => parseForzaGarageCatalog(JSON.stringify({
		format: "forzagarage-car-tracker", version: 1, cars: [],
	})), /unsupported or empty format/);
});

test("ForzaGarage adapter is registered and restricts changes to its tracker page", () => {
	assert.equal(getSiteAdapter("forzagarage"), forzaGarageAdapter);
	assert.equal(forzaGarageAdapter.isValidCarId("POR_3_917LHFE_70"), true);
	assert.equal(forzaGarageAdapter.isValidCarId("POR/3"), false);
	assert.doesNotThrow(() => forzaGarageAdapter.assertReady("https://forzagarage.com/car-tracker/#g=abc"));
	assert.throws(() => forzaGarageAdapter.assertReady("https://forzagarage.com/"), /Car Tracker/);
	assert.throws(() => forzaGarageAdapter.assertReady("https://forzagarage.com.example/car-tracker/"), /Car Tracker/);
});

test("owned planning selects the ForzaGarage ID rather than another site's ID", () => {
	const entries = parseForzaGarageCatalog(trackerPage);
	const plan = buildOwnedGaragePlan([{
		source: "tiles/page-001-r1-c1.png",
		text: "RSX Type S\n2002 Acura",
		ownership: { status: "owned", labelText: "COMMON" },
	}], entries, {}, forzaGarageAdapter);
	assert.deepEqual(plan, {
		site: "forzagarage",
		owned: [{
			id: "ACU_RSX_02",
			name: "2002 Acura RSX Type-S",
			sources: ["tiles/page-001-r1-c1.png"],
		}],
		review: [],
	});

});

test("duplicate ForzaGarage display names remain ambiguous and are excluded from owned plans", () => {
		const name = "2026 GR GT Prototype";
		const entries = mergeCatalogEntries([
			[{ name, ordinal: "1234" }],
			[
				{ name, siteIds: { forzagarage: "TOY_Scallop_26" } },
				{ name, siteIds: { forzagarage: "TOY_ScallopID_26" } },
			],
		]);
		assert.equal(entries.length, 3);
		const plan = buildOwnedGaragePlan([{
			source: "one",
			text: "GT Prototype\n2026 GR",
			ownership: { status: "owned", labelText: "COMMON" },
		}], entries, {}, forzaGarageAdapter);
		assert.deepEqual(plan.owned, []);
		assert.match(plan.review[0]!, /no unique exact ForzaGarage name/);
});
