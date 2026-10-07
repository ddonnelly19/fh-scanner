import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { parseCarNameMapping } from "../src/collection/car-matching.ts";
import { forzaGarageAdapter } from "../src/sites/forzagarage/adapter.ts";
import { kudosPrimeAdapter } from "../src/sites/kudosprime/adapter.ts";
import { loadOwnershipCatalogs } from "../src/workflows/ownership-input.ts";

test("ownership loads all present snapshots without requiring newly registered sites for older runs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-ownership-input-"));
	try {
		await writeFile(join(directory, "car-ordinals-source.json"), '{"2002 Acura RSX Type-S":"422"}');
		await writeFile(join(directory, "kudosprime-source.js"),
			'fh6.cars = [{"id":"4","text":"2002 Acura RSX Type-S"},{"id":"5","text":"1932 Ford De Luxe Coupe"}];');
		assert.equal((await loadOwnershipCatalogs(directory, kudosPrimeAdapter)).length, 2);
		await writeFile(join(directory, "forzagarage-source.json"), JSON.stringify({
			format: "forzagarage-car-tracker",
			version: 1,
			cars: [{ id: "ACU_RSX_02", name: "2002 Acura RSX Type-S" }],
		}));
		const entries = await loadOwnershipCatalogs(directory, forzaGarageAdapter);
		assert.doesNotThrow(() => parseCarNameMapping({
			"1932 Ford De Luxe Five-Window Coupe": {
				selected: null,
				candidates: ["1932 Ford De Luxe Coupe"],
			},
		}, entries));
		assert.deepEqual(entries[0]!.siteIds, { kudosprime: "4", forzagarage: "ACU_RSX_02" });
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("ownership gives an actionable error for a missing target snapshot without downloading it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-ownership-missing-"));
	try {
		await assert.rejects(loadOwnershipCatalogs(directory, forzaGarageAdapter),
			/Missing ForzaGarage catalog snapshot.*match-ordinals/);
	} finally {
		await rm(directory, { recursive: true });
	}
});
