import { readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import sharp from "sharp";
import { defaultScreenshotsDirectory } from "../workflows/run-directory.ts";
import { buildIconTemplates, cardPixels, defaultIconDirectory, findCards, iconBoxes } from "../ocr/my-cars-cards.ts";
import type { IconKind, IconTemplate } from "../ocr/my-cars-cards.ts";
import type { GarageCar } from "../capture/garage-walk.ts";

/**
 * Rebuilds the My Cars card icon templates from garage walks. Each walk screenshot highlights the walked car,
 * whose drivetrain and tires garage.json records, so the highlighted card's icons are labelled samples.
 * Only the small icon crops are written, never anything else from the screenshots.
 *
 * Usage: node src\cli\card-icon-templates.ts [garage directory...]   (default: every screenshots\garage-*)
 */
const directories = process.argv.slice(2);
if (!directories.length) {
	for (const entry of await readdir(defaultScreenshotsDirectory, { withFileTypes: true })) {
		if (entry.isDirectory() && entry.name.startsWith("garage-")) directories.push(join(defaultScreenshotsDirectory, entry.name));
	}
}
const samples: IconTemplate[] = [];
for (const directory of directories) {
	const manifest = JSON.parse(await readFile(join(directory, "garage.json"), "utf8")) as { cars: GarageCar[] };
	for (const car of manifest.cars) {
		const labels: Record<IconKind, string | null> = { drivetrain: car.drivetrain, tires: car.tires };
		for (const screenshot of car.screenshots.captures) {
			const image = await readFile(join(directory, screenshot));
			const selected = (await findCards(image)).cards.find((card) => card.selected);
			if (!selected) {
				console.warn(`${directory}\\${screenshot}: no highlighted card found; skipped.`);
				continue;
			}
			for (const kind of ["drivetrain", "tires"] as const) {
				const label = labels[kind];
				if (label === null) continue;
				const box = iconBoxes[kind];
				samples.push({ kind, label, width: box.width, height: box.height, pixels: await cardPixels(image, selected.bounds, box) });
			}
		}
	}
}
const templates = buildIconTemplates(samples);
const output = fileURLToPath(defaultIconDirectory);
await mkdir(output, { recursive: true });
for (const file of await readdir(output)) {
	if (/^(drivetrain|tires)-.*\.png$/.test(file)) await rm(join(output, file));
}
const variants = new Map<string, number>();
for (const template of templates) {
	const key = `${template.kind}-${template.label.replaceAll(" ", "_")}`;
	const variant = (variants.get(key) ?? 0) + 1;
	variants.set(key, variant);
	await writeFile(join(output, `${key}-${variant}.png`), await sharp(Buffer.from(template.pixels), {
		raw: { width: template.width, height: template.height, channels: 1 },
	}).png().toBuffer());
	console.log(`${key}-${variant}.png`);
}
console.log(`Built ${templates.length} templates from ${samples.length} icon samples in ${directories.length} walk(s).`);
