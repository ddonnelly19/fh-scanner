import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { defaultCarMappingPath } from "../collection/car-matching.ts";
import { exportCarOrdinals } from "../workflows/export-cars.ts";
import { resolveRunDirectory } from "../workflows/run-directory.ts";

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { "run-dir": { type: "string" }, catalog: { type: "string" }, mapping: { type: "string" }, "kudos-catalog": { type: "string" } },
	});
	if (values.catalog !== undefined && !values.catalog.trim()) throw new Error("--catalog must not be empty.");
	if (values.mapping !== undefined && !values.mapping.trim()) throw new Error("--mapping must not be empty.");
	if (values["kudos-catalog"] !== undefined && !values["kudos-catalog"].trim()) throw new Error("--kudos-catalog must not be empty.");
	const directory = await resolveRunDirectory(values["run-dir"]);
	console.log(`[+] Selected run: ${directory}`);
	const tileDirectory = join(directory, "tiles");
	const filenames = (await readdir(tileDirectory))
		.filter((name) => /^page-\d+-r[1-3]-c[1-5]\.txt$/.test(name))
		.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
	if (!filenames.length) throw new Error(`No tile OCR text files found in ${tileDirectory}.`);
	const cars = [];
	for (const name of filenames) {
		cars.push({ source: join("tiles", name), text: await readFile(join(tileDirectory, name), "utf8") });
	}
	const mappingPath = values.mapping === undefined ? defaultCarMappingPath : resolve(values.mapping);
	const result = await exportCarOrdinals(cars, directory, {
		mappingPath,
		...(values.catalog !== undefined ? { catalogPath: values.catalog } : {}),
		...(values["kudos-catalog"] !== undefined ? { siteCatalogPaths: { kudosprime: values["kudos-catalog"] } } : {}),
	});
	console.log(`[+] Car name mapping updated: ${mappingPath}`);
	console.log(`[+] ${result.matched}/${cars.length} captured cars matched; ${result.uniqueNames} unique matched car names written to ${join(directory, "ordinals.txt")}.`);
	if (result.unresolved) {
		console.warn(`[!] ${result.unresolved} unresolved cars require review: ${join(directory, "ordinal-review.txt")}`);
	}
}

main().catch((error: unknown) => {
	console.error("[-] Ordinal matching failed. Existing OCR text is retained:", error);
	process.exitCode = 1;
});
