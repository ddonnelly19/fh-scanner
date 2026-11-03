import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { loadOwnershipCatalog } from "../src/workflows/ownership-input.ts";

test("ownership reads the run's saved ordinal snapshot", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-ownership-input-"));
	try {
		await writeFile(join(directory, "car-ordinals-source.json"), '{"2002 Acura RSX Type-S":"422"}');
		assert.deepEqual(await loadOwnershipCatalog(directory), [{ name: "2002 Acura RSX Type-S", ordinal: "422" }]);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("ownership gives an actionable error when the run hasn't been matched", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-ownership-missing-"));
	try {
		await assert.rejects(loadOwnershipCatalog(directory), /Missing "car-ordinals-source.json".*match-ordinals/);
	} finally {
		await rm(directory, { recursive: true });
	}
});
