import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultCarMappingPath, loadCarNameMapping } from "../collection/car-matching.ts";
import { loadOrdinalCatalog } from "../catalogs/hdr.ts";
import { detectTileOwnership } from "../ocr/car-ownership.ts";
import type { OwnedCarInput } from "../ocr/car-ownership.ts";
import { createLocalOCRWorker } from "../ocr/ocr.ts";
import { buildOwnedGaragePlan } from "../sites/garage-plan.ts";
import { getSiteAdapter } from "../sites/registry.ts";
import { mergeCatalogEntries } from "../workflows/export-cars.ts";
import { resolveRunDirectory } from "../workflows/run-directory.ts";

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { "run-dir": { type: "string" }, site: { type: "string", default: "kudosprime" } } });
	const site = getSiteAdapter(values.site);
	const directory = await resolveRunDirectory(values["run-dir"]);
	console.log(`[+] Selected run: ${directory}`);
	const entries = mergeCatalogEntries([
		(await loadOrdinalCatalog(join(directory, "car-ordinals-source.json"))).entries,
		(await site.catalog.load(join(directory, site.catalog.snapshotFile))).entries,
	]);
	const mapping = await loadCarNameMapping(defaultCarMappingPath, entries);
	const tiles = join(directory, "tiles");
	const files = (await readdir(tiles)).filter((name) => /^page-\d+-r[1-3]-c[1-5]\.png$/.test(name))
		.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	if (!files.length) throw new Error("No captured car tiles found.");
	const cars: OwnedCarInput[] = [];
	const worker = await createLocalOCRWorker();
	try {
		for (const [index, name] of files.entries()) {
			const source = join("tiles", name);
			const text = await readFile(join(tiles, `${name.slice(0, -4)}.txt`), "utf8");
			const ownership = await detectTileOwnership(await readFile(join(tiles, name)), worker);
			cars.push({ source, text, ownership });
			console.log(`[${index + 1}/${files.length}] ${ownership.status}: ${name}`);
		}
	} finally {
		await worker.terminate();
	}
	const plan = buildOwnedGaragePlan(cars, entries, mapping, site);
	await writeFile(join(directory, "ownership-evidence.json"), `${JSON.stringify(cars, null, 2)}\n`);
	await writeFile(join(directory, site.planFile), `${JSON.stringify(plan, null, 2)}\n`);
	console.log(`[+] Dry run only: ${plan.owned.length} unique verified-owned site IDs; ${plan.review.length} items need review. No account updates sent.`);
}

main().catch((error: unknown) => {
	console.error("[-] Ownership review failed:", error);
	process.exitCode = 1;
});
