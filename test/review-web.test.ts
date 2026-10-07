import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { test } from "vitest";
import { forzaGarageAdapter } from "../src/sites/forzagarage/adapter.ts";
import { buildOwnedGaragePlan } from "../src/sites/garage-plan.ts";
import { createReviewData, parseOwnershipEvidence } from "../src/web/review-data.ts";
import { loadSiteMapping, parseSiteMapping } from "../src/workflows/site-mapping.ts";
import { loadOwnershipCatalogs } from "../src/workflows/ownership-input.ts";
import { createReviewServer } from "../src/web/review-server.ts";
import { createWorkflow, confirmPreview } from "../src/web/workflow.ts";
import { applyOwnershipOverrides, loadOwnershipOverrides } from "../src/workflows/ownership-overrides.ts";

test("web matches persist by exact site ID, regenerate plans without OCR and survive ownership reruns", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-web-review-"));
	try {
		await writeFile(join(directory, "car-ordinals-source.json"), '{"2007 Alfa Romeo 8C Competizione":"1"}');
		await writeFile(join(directory, "forzagarage-source.json"), JSON.stringify({
			format: "forzagarage-car-tracker", version: 1, cars: [
				{ id: "ALF_8C_08", name: "2008 Alfa Romeo 8C Competizione" },
				{ id: "TOY_Scallop_26", name: "2026 GR GT Prototype" },
				{ id: "TOY_ScallopID_26", name: "2026 GR GT Prototype" },
			],
		}));
		const cars = [
			{ source: "tiles\\page-001-r1-c1.png", text: "8C Competizione\n2007 Alfa Romeo", ownership: { status: "owned", labelText: "EPIC" } },
			{ source: "tiles\\page-001-r1-c2.png", text: "GT Prototype\n2026 GR", ownership: { status: "owned", labelText: "COMMON" } },
			{ source: "tiles\\page-001-r1-c3.png", text: "GT Prototype\n2026 GR", ownership: { status: "unknown", labelText: "" } },
		];
		await writeFile(join(directory, "ownership-evidence.json"), JSON.stringify(cars));
		const mappingPath = join(directory, "name-mapping.json");
		await writeFile(mappingPath, "{}");
		const data = await createReviewData(directory, forzaGarageAdapter, mappingPath);
		assert.equal(data.snapshot().items.length, 3);
		assert.equal(data.snapshot().ownedCount, 0);
		await assert.rejects(data.save(cars[2]!.source, "ALF_8C_08"), /verified owned/);
		await assert.rejects(data.save(cars[0]!.source, "nonexistent"), /Invalid/);
		await data.save(cars[0]!.source, "ALF_8C_08");
		const saved = await data.save(cars[1]!.source, "TOY_ScallopID_26");
		assert.equal(saved.ownedCount, 2);
		assert.equal(saved.reviewCount, 1);
		assert.equal(await readFile(mappingPath, "utf8"), "{}");
		const entries = await loadOwnershipCatalogs(directory, forzaGarageAdapter);
		const manual = await loadSiteMapping(directory, forzaGarageAdapter, entries);
		const plan = buildOwnedGaragePlan(parseOwnershipEvidence(cars), entries, {}, forzaGarageAdapter, manual);
		assert.deepEqual(JSON.parse(await readFile(join(directory, forzaGarageAdapter.planFile), "utf8")), plan);
		const reopened = await createReviewData(directory, forzaGarageAdapter, mappingPath);
		assert.equal(reopened.snapshot().ownedCount, 2);
		await reopened.save(cars[0]!.source, null);
		assert.equal(reopened.snapshot().ownedCount, 1);
		await reopened.saveOwnership(cars[2]!.source, "owned");
		await reopened.save(cars[2]!.source, "ALF_8C_08");
		assert.equal(reopened.snapshot().ownedCount, 2);
		const overrides = await loadOwnershipOverrides(directory);
		assert.equal(overrides[cars[2]!.source], "owned");
		assert.equal(JSON.parse(await readFile(join(directory, "ownership-evidence.json"), "utf8"))[2].ownership.status, "unknown");
		assert.equal(applyOwnershipOverrides(parseOwnershipEvidence(cars), overrides)[2]!.ownership.status, "owned");
		await reopened.saveOwnership(cars[2]!.source, null);
		assert.equal(reopened.snapshot().unknownCount, 1);
		assert.equal(reopened.snapshot().ownedCount, 1);
		await writeFile(mappingPath, '{"changed":null}');
		await assert.rejects(reopened.save(cars[0]!.source, "ALF_8C_08"), /Local inputs changed/);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("web input validation rejects malformed evidence, duplicate tiles, unsafe sources and cross-site IDs", () => {
	const car = { source: "tiles/page-001-r1-c1.png", text: "", ownership: { status: "owned", labelText: "RARE" } };
	for (const value of [null, [], [car, car], [{ ...car, source: "..\\secret.png" }], [{ ...car, ownership: { status: "yes", labelText: "" } }]]) {
		assert.throws(() => parseOwnershipEvidence(value));
	}
	assert.throws(() => parseSiteMapping({ site: "kudosprime", matches: {} }, forzaGarageAdapter, []), /Invalid/);
	assert.throws(() => parseSiteMapping({ site: "forzagarage", matches: { "../secret": "ALF_8C_08" } }, forzaGarageAdapter, []), /Invalid/);
});

test("local HTTP review serves UI, rejects unauthenticated writes and saves verified matches", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-web-http-"));
	let server: Server | undefined;
	try {
		await writeFile(join(directory, "car-ordinals-source.json"), '{"2007 Alfa Romeo 8C Competizione":"1"}');
		await writeFile(join(directory, "forzagarage-source.json"), JSON.stringify({
			format: "forzagarage-car-tracker", version: 1,
			cars: [{ id: "ALF_8C_08", name: "2008 Alfa Romeo 8C Competizione" }],
		}));
		const source = "tiles\\page-001-r1-c1.png";
		await writeFile(join(directory, "ownership-evidence.json"), JSON.stringify([
			{ source, text: "8C Competizione\n2007 Alfa Romeo", ownership: { status: "owned", labelText: "EPIC" } },
		]));
		server = await createReviewServer(directory, forzaGarageAdapter, join(directory, "missing-mapping.json"));
		await new Promise<void>((resolve, reject) => {
			server!.once("error", reject);
			server!.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const base = `http://127.0.0.1:${address.port}`;
		const html = await (await fetch(base)).text();
		const token = /name="review-token" content="([^"]+)"/.exec(html)?.[1];
		assert.ok(token);
		assert.equal((await fetch(`${base}/review.js`)).status, 200);
		assert.equal((await fetch(`${base}/tile?source=..%2Fsecret`)).status, 404);
		assert.equal((await fetch(`${base}/api/match`, { method: "POST", body: "{}" })).status, 403);
		assert.equal((await fetch(`${base}/api/match`, {
			method: "POST", headers: { Origin: "https://example.com", "X-Review-Token": token }, body: "{}",
		})).status, 403);
		const result = await fetch(`${base}/api/match`, {
			method: "POST",
			headers: { Origin: base, "X-Review-Token": token, "Content-Type": "application/json" },
			body: JSON.stringify({ source, id: "ALF_8C_08", revision: (await (await fetch(`${base}/api/state`)).json()).revision }),
		});
		assert.equal(result.status, 200);
		const snapshot = await (await fetch(`${base}/api/review`)).json();
		assert.equal(snapshot.ownedCount, 1);
		const plan = JSON.parse(await readFile(join(directory, forzaGarageAdapter.planFile), "utf8"));
		assert.equal(plan.owned[0].id, "ALF_8C_08");
		const oldRevision = (await (await fetch(`${base}/api/state`)).json()).revision;
		const post = (path: string, body: object) => fetch(`${base}${path}`, {
			method: "POST", headers: { Origin: base, "X-Review-Token": token, "Content-Type": "application/json" },
			body: JSON.stringify({ ...body, revision: oldRevision }),
		});
		assert.equal((await post("/api/ownership", { source, status: "owned" })).status, 400);
		assert.equal((await post("/api/ownership", { source, status: "unowned", verified: true })).status, 200);
		assert.equal((await post("/api/match", { source, id: "ALF_8C_08" })).status, 400);
		assert.equal(JSON.parse(await readFile(join(directory, forzaGarageAdapter.planFile), "utf8")).owned.length, 0);
		const preview = await (await fetch(`${base}/api/plan`)).json();
		assert.equal(preview.cars.length, 0);
	} finally {
		if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
		await rm(directory, { recursive: true });
	}
});

test("sync requires exact confirmation and rejects changed plan, site or run", () => {
	const plan = { site: "forzagarage", directory: "run-a", hash: "one",
		cars: [{ id: "ALF_8C_08", name: "2008 Alfa Romeo 8C Competizione", sources: ["one"] }], review: [] };
	assert.doesNotThrow(() => confirmPreview(plan, plan, "APPLY 1"));
	for (const confirmation of ["apply 1", "APPLY 2", "", " APPLY 1"]) {
		assert.throws(() => confirmPreview(plan, plan, confirmation), /Type APPLY/);
	}
	for (const current of [{ ...plan, hash: "two" }, { ...plan, site: "kudosprime" }, { ...plan, directory: "run-b" }]) {
		assert.throws(() => confirmPreview(plan, current, "APPLY 1"), /plan changed/);
	}
	assert.throws(() => confirmPreview({ ...plan, cars: [] }, { ...plan, cars: [] }, "APPLY 0"), /empty/);
});

test("dashboard starts without review inputs, selects only listed runs and surfaces job failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-workflow-missing-"));
	const workflow = await createWorkflow(directory, forzaGarageAdapter, join(directory, "mapping.json"));
	try {
		const state = await workflow.state();
		assert.match(state.reviewError, /Missing ForzaGarage/);
		assert.ok(state.sites.some((site) => site.id === "kudosprime"));
		workflow.assertEditable(state.revision);
		assert.throws(() => workflow.assertEditable(state.revision + 1), /out of date/);
		await assert.rejects(workflow.select(join(directory, "not-listed"), "forzagarage"), /listed/);
		await workflow.select(directory, "kudosprime");
		assert.equal((await workflow.state()).site, "kudosprime");
		workflow.startJob("ownership");
		assert.equal((await workflow.state()).job.state, "running");
		assert.throws(() => workflow.assertEditable((state.revision + 1)), /active job/);
		for (let attempt = 0; attempt < 100; attempt++) {
			if ((await workflow.state()).job.state !== "running") break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const failed = await workflow.state();
		assert.equal(failed.job.state, "failed");
		assert.match(failed.job.log, /Missing KudosPrime/);
		assert.ok(failed.job.error);
		await assert.rejects(workflow.confirmSync("APPLY 1", true), /Open the sync browser/);
	} finally {
		await workflow.dispose();
		await rm(directory, { recursive: true });
	}
});

test("preview refuses stale saved plans and external evidence changes before browser launch", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-workflow-preview-"));
	let launches = 0;
	const mappingPath = join(directory, "mapping.json");
	await writeFile(mappingPath, "{}");
	await writeFile(join(directory, "car-ordinals-source.json"), '{"2008 Alfa Romeo 8C Competizione":"1"}');
	await writeFile(join(directory, "forzagarage-source.json"), JSON.stringify({
		format: "forzagarage-car-tracker", version: 1,
		cars: [{ id: "ALF_8C_08", name: "2008 Alfa Romeo 8C Competizione" }],
	}));
	await writeFile(join(directory, "ownership-evidence.json"), JSON.stringify([{
		source: "tiles\\page-001-r1-c1.png", text: "8C Competizione\n2008 Alfa Romeo",
		ownership: { status: "owned", labelText: "EPIC" },
	}]));
	const workflow = await createWorkflow(directory, forzaGarageAdapter, mappingPath, async () => {
		launches++; throw new Error("Test browser unavailable.");
	});
	try {
		await workflow.review.regenerate();
		const preview = await workflow.preview();
		assert.equal(preview.cars.length, 1);
		await assert.rejects(workflow.openSync("wrong-hash"), /Preview the current plan/);
		assert.equal(launches, 0);
		await writeFile(join(directory, forzaGarageAdapter.planFile), JSON.stringify({ site: "forzagarage", owned: [], review: [] }));
		await assert.rejects(workflow.preview(), /saved plan is stale/);
		await workflow.review.regenerate();
		await writeFile(mappingPath, '{"new":null}');
		await assert.rejects(workflow.openSync(preview.hash), /Local inputs changed/);
		assert.equal(launches, 0);
		await workflow.refresh();
		const current = await workflow.preview();
		await assert.rejects(workflow.openSync(current.hash), /Test browser unavailable/);
		assert.equal((await workflow.state()).sync.state, "failed");
		await workflow.closeSync();
		assert.equal((await workflow.state()).locked, false);
	} finally {
		await workflow.dispose();
		await rm(directory, { recursive: true });
	}
});
