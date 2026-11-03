import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { defaultCarMappingPath, loadCarNameMapping } from "../collection/car-matching.ts";
import { detectTileOwnership } from "../ocr/car-ownership.ts";
import type { OwnedCarInput } from "../ocr/car-ownership.ts";
import { createLocalOCRWorker } from "../ocr/ocr.ts";
import { loadOwnershipCatalog } from "../workflows/ownership-input.ts";
import { buildOwnedCars, loadManualMatches, ownedCarsFile } from "../workflows/owned-cars.ts";
import { applyOwnershipOverrides, loadOwnershipOverrides } from "../workflows/ownership-overrides.ts";
import { resolveRunDirectory } from "../workflows/run-directory.ts";

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { "run-dir": { type: "string" } } });
	const directory = await resolveRunDirectory(values["run-dir"]);
	console.log(`[+] Selected run: ${directory}`);
	const entries = await loadOwnershipCatalog(directory);
	const mapping = await loadCarNameMapping(defaultCarMappingPath, entries);
	const manual = await loadManualMatches(directory, entries);
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
	const overrides = await loadOwnershipOverrides(directory);
	const owned = buildOwnedCars(applyOwnershipOverrides(cars, overrides), entries, mapping, manual, directory);
	const ownedPath = join(directory, ownedCarsFile);
	await writeFile(join(directory, "ownership-evidence.json"), `${JSON.stringify(cars, null, 2)}\n`);
	await writeFile(ownedPath, `${JSON.stringify(owned, null, 2)}\n`);
	console.log(`[+] ${owned.cars.length} owned cars written to ${ownedPath}; ${owned.review.length} tiles need review.`);
	console.log(`[+] To mark them owned on a site, from the forzagarage repo: npm run collection-sync -- "${ownedPath}" --site forzalabs`);
}

main().catch((error: unknown) => {
	console.error("[-] Ownership review failed:", error);
	process.exitCode = 1;
});
