import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { readSyncPlan } from "../src/workflows/sync-input.ts";
import { resolveRunDirectory } from "../src/workflows/run-directory.ts";

test("explicit run overrides discovery and empty input fails", async () => {
	assert.equal(await resolveRunDirectory("custom-run", "missing"), resolve("custom-run"));
	await assert.rejects(resolveRunDirectory(" ", "missing"), /must not be empty/);
});

test("selects newest scan by creation, not edits or plan availability; missing plan explains next step", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-sync-input-"));
	try {
		const oldRun = join(directory, "scan-old");
		const newRun = join(directory, "scan-new");
		await mkdir(oldRun);
		await writeFile(join(oldRun, "kudos-owned-plan.json"), '{"owned":[]}');
		await new Promise((resolve) => setTimeout(resolve, 50));
		await mkdir(newRun);
		await mkdir(join(directory, "not-a-scan"));
		await writeFile(join(directory, "scan-file"), "not a directory");
		await utimes(oldRun, new Date(), new Date(Date.now() + 60000));
		assert.equal(await resolveRunDirectory(undefined, directory), newRun);
		await assert.rejects(readSyncPlan(newRun, "kudos-owned-plan.json", "kudosprime"), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes(`--run-dir "${newRun}" --site kudosprime`));
			assert.match(error.message, /No account updates sent/);
			return true;
		});
		await writeFile(join(newRun, "kudos-owned-plan.json"), '{"site":"kudosprime","owned":[]}');
		assert.deepEqual(await readSyncPlan(newRun, "kudos-owned-plan.json", "kudosprime"), { site: "kudosprime", owned: [] });
		await writeFile(join(newRun, "kudos-owned-plan.json"), "bad json");
		await assert.rejects(readSyncPlan(newRun, "kudos-owned-plan.json", "kudosprime"), SyntaxError);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("missing or empty screenshots directory fails explicitly", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-sync-empty-"));
	try {
		await assert.rejects(resolveRunDirectory(undefined, directory), /No saved scans/);
		await assert.rejects(resolveRunDirectory(undefined, join(directory, "missing")), /No saved scans/);
	} finally {
		await rm(directory, { recursive: true });
	}
});
