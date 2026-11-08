import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { addPageReadings } from "../capture/garage-pages.ts";
import type { GarageCard, GaragePage } from "../capture/garage-pages.ts";
import { createLocalOCRWorker } from "../ocr/ocr.ts";
import { loadIconTemplates, readCardPage } from "../ocr/my-cars-cards.ts";

/**
 * Reads the saved screenshots of a page scan again with the current card reader, for example after new icon
 * templates, and writes the result next to the original (garage-pages.reread.json unless --out names another
 * file). Prints how many cards each kind of issue flags, before and after.
 *
 * Usage: node src\cli\reread-pages.ts <pages directory> [--out file.json]
 */
const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: "string", default: "garage-pages.reread.json" } } });
const directory = positionals[0];
if (!directory || positionals.length > 1) throw new Error("Usage: reread-pages.ts <pages directory> [--out file.json]");
if (values.out === "garage-pages.json") throw new Error("--out must not overwrite garage-pages.json.");

/** An issue with its quoted text and numbers taken out, so the same kind of issue counts together. */
export function issueKind(issue: string): string {
	return issue.replace(/\(.*?\)|"[^"]*"|\{.*\}/g, "…").replace(/\d+(\.\d+)?/g, "N").replace(/\b(S[12]|[DCBASRX])\b/g, "K").trim();
}

function tally(cars: GarageCard[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const car of cars) for (const kind of new Set(car.issues.map(issueKind))) counts.set(kind, (counts.get(kind) ?? 0) + 1);
	return counts;
}

const manifestPath = join(directory, "garage-pages.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { pages: GaragePage[]; cars: GarageCard[] } & Record<string, unknown>;
const templates = await loadIconTemplates();
const [worker, shapeWorker] = await Promise.all([createLocalOCRWorker(), createLocalOCRWorker("legacy")]);
const cards = new Map<string, GarageCard>();
const pages: GaragePage[] = [];
try {
	for (const original of manifest.pages) {
		const page: GaragePage = { ...original, cards: 0 };
		delete page.error;
		try {
			const { cards: readings } = await readCardPage(await readFile(join(directory, page.screenshot)), worker, shapeWorker, templates);
			page.cards = readings.length;
			addPageReadings(cards, page, readings);
		} catch (error) {
			page.error = error instanceof Error ? error.message : String(error);
		}
		pages.push(page);
		console.error(`Page ${page.page}: ${page.cards} cards${page.error ? ` (failed: ${page.error})` : ""}`);
	}
} finally {
	await Promise.all([worker.terminate(), shapeWorker.terminate()]);
}
const cars = [...cards.values()].sort((a, b) => a.column - b.column || a.row - b.row);
await writeFile(join(directory, values.out), JSON.stringify({ ...manifest, rereadAt: new Date().toISOString(), pages, cars }, null, 2));

const before = tally(manifest.cars);
const after = tally(cars);
console.log(`Cards: ${manifest.cars.length} before, ${cars.length} after.`);
console.log(`Flagged: ${manifest.cars.filter((car) => car.issues.length).length} before, ${cars.filter((car) => car.issues.length).length} after.`);
console.log("\n before   after  issue");
for (const kind of [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => (after.get(b) ?? 0) - (after.get(a) ?? 0))) {
	console.log(`${String(before.get(kind) ?? 0).padStart(7)} ${String(after.get(kind) ?? 0).padStart(7)}  ${kind}`);
}
console.log(`\nSaved ${join(directory, values.out)}`);
