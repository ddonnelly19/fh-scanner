import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { test } from "vitest";
import { createReviewData, parseOwnershipEvidence } from "../src/web/review-data.ts";
import { createReviewServer } from "../src/web/review-server.ts";
import { createWorkflow } from "../src/web/workflow.ts";
import { applyOwnershipOverrides, loadOwnershipOverrides } from "../src/workflows/ownership-overrides.ts";

const catalog = '{"2007 Alfa Romeo 8C Competizione":"1","2025 GR GT Prototype":"4221"}';

test("manual matches persist by ordinal, rewrite owned-cars.json without OCR and survive ownership reruns", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-web-review-"));
	try {
		await writeFile(join(directory, "car-ordinals-source.json"), catalog);
		const cars = [
			{ source: "tiles\\page-001-r1-c1.png", text: "8C Competizione\n2007 Alfa Romeo", ownership: { status: "owned", labelText: "EPIC" } },
			{ source: "tiles\\page-001-r1-c2.png", text: "GT Prototype\n2026 GR", ownership: { status: "owned", labelText: "COMMON" } },
			{ source: "tiles\\page-001-r1-c3.png", text: "GT Prototype\n2026 GR", ownership: { status: "unknown", labelText: "" } },
		];
		await writeFile(join(directory, "ownership-evidence.json"), JSON.stringify(cars));
		const mappingPath = join(directory, "name-mapping.json");
		await writeFile(mappingPath, "{}");
		const data = await createReviewData(directory, mappingPath);
		assert.equal(data.snapshot().items.length, 3);
		assert.equal(data.snapshot().ownedCount, 1);
		await assert.rejects(data.save(cars[2]!.source, "1"), /verified owned/);
		await assert.rejects(data.save(cars[1]!.source, "999"), /Invalid/);
		const saved = await data.save(cars[1]!.source, "4221");
		assert.equal(saved.ownedCount, 2);
		assert.equal(saved.reviewCount, 1);
		assert.equal(await readFile(mappingPath, "utf8"), "{}");
		const owned = JSON.parse(await readFile(join(directory, "owned-cars.json"), "utf8"));
		assert.deepEqual(owned.cars.map((car: { ordinal: number }) => car.ordinal), [1, 4221]);
		assert.deepEqual(JSON.parse(await readFile(join(directory, "car-matches.json"), "utf8")), { matches: { [cars[1]!.source]: "4221" } });
		const reopened = await createReviewData(directory, mappingPath);
		assert.equal(reopened.snapshot().ownedCount, 2);
		await reopened.save(cars[1]!.source, null);
		assert.equal(reopened.snapshot().ownedCount, 1);
		await reopened.saveOwnership(cars[2]!.source, "owned");
		await reopened.save(cars[2]!.source, "4221");
		assert.equal(reopened.snapshot().ownedCount, 2);
		const overrides = await loadOwnershipOverrides(directory);
		assert.equal(overrides[cars[2]!.source], "owned");
		assert.equal(JSON.parse(await readFile(join(directory, "ownership-evidence.json"), "utf8"))[2].ownership.status, "unknown");
		assert.equal(applyOwnershipOverrides(parseOwnershipEvidence(cars), overrides)[2]!.ownership.status, "owned");
		await reopened.saveOwnership(cars[2]!.source, null);
		assert.equal(reopened.snapshot().unknownCount, 1);
		assert.equal(reopened.snapshot().ownedCount, 1);
		await writeFile(mappingPath, '{"changed":null}');
		await assert.rejects(reopened.save(cars[0]!.source, "1"), /Local inputs changed/);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("web input validation rejects malformed evidence, duplicate tiles and unsafe sources", () => {
	const car = { source: "tiles/page-001-r1-c1.png", text: "", ownership: { status: "owned", labelText: "RARE" } };
	for (const value of [null, [], [car, car], [{ ...car, source: "..\\secret.png" }], [{ ...car, ownership: { status: "yes", labelText: "" } }]]) {
		assert.throws(() => parseOwnershipEvidence(value));
	}
});

test("local HTTP review serves UI, rejects unauthenticated writes and saves verified matches", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-web-http-"));
	let server: Server | undefined;
	try {
		await writeFile(join(directory, "car-ordinals-source.json"), catalog);
		const source = "tiles\\page-001-r1-c1.png";
		await writeFile(join(directory, "ownership-evidence.json"), JSON.stringify([
			{ source, text: "8C Competizione\n2008 Alfa Romeo", ownership: { status: "owned", labelText: "EPIC" } },
		]));
		server = await createReviewServer(directory, join(directory, "missing-mapping.json"));
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
			body: JSON.stringify({ source, id: "1", revision: (await (await fetch(`${base}/api/state`)).json()).revision }),
		});
		assert.equal(result.status, 200);
		const snapshot = await (await fetch(`${base}/api/review`)).json();
		assert.equal(snapshot.ownedCount, 1);
		assert.equal(JSON.parse(await readFile(join(directory, "owned-cars.json"), "utf8")).cars[0].ordinal, 1);
		const oldRevision = (await (await fetch(`${base}/api/state`)).json()).revision;
		const post = (path: string, body: object) => fetch(`${base}${path}`, {
			method: "POST", headers: { Origin: base, "X-Review-Token": token, "Content-Type": "application/json" },
			body: JSON.stringify({ ...body, revision: oldRevision }),
		});
		assert.equal((await post("/api/ownership", { source, status: "owned" })).status, 400);
		assert.equal((await post("/api/ownership", { source, status: "unowned", verified: true })).status, 200);
		assert.equal((await post("/api/match", { source, id: "1" })).status, 400);
		assert.equal(JSON.parse(await readFile(join(directory, "owned-cars.json"), "utf8")).cars.length, 0);
		assert.equal((await fetch(`${base}/api/plan`)).status, 404);
	} finally {
		if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
		await rm(directory, { recursive: true });
	}
});

test("dashboard starts without review inputs, selects only listed runs and surfaces job failures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-workflow-missing-"));
	const workflow = await createWorkflow(directory, join(directory, "mapping.json"));
	try {
		const state = await workflow.state();
		assert.match(state.reviewError, /Missing "car-ordinals-source.json"/);
		assert.equal(state.ownedFile, join(directory, "owned-cars.json"));
		workflow.assertEditable(state.revision);
		assert.throws(() => workflow.assertEditable(state.revision + 1), /out of date/);
		await assert.rejects(workflow.select(join(directory, "not-listed")), /listed/);
		workflow.startJob("ownership");
		assert.equal((await workflow.state()).job.state, "running");
		const running = (await workflow.state()).revision;
		assert.throws(() => workflow.assertEditable(running), /running job/);
		for (let attempt = 0; attempt < 100; attempt++) {
			if ((await workflow.state()).job.state !== "running") break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const failed = await workflow.state();
		assert.equal(failed.job.state, "failed");
		assert.match(failed.job.log, /Missing "car-ordinals-source.json"/);
		assert.ok(failed.job.error);
	} finally {
		await workflow.dispose();
		await rm(directory, { recursive: true });
	}
});
