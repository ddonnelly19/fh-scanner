import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLocalOCRWorker } from "../ocr/ocr.ts";
import { loadIconTemplates, readCardPage } from "../ocr/my-cars-cards.ts";
import type { CardReading } from "../ocr/my-cars-cards.ts";
import type { GarageCar } from "../capture/garage-walk.ts";

/**
 * Checks the My Cars card reader against garage walks. Every walk screenshot shows a full page of cards; the
 * highlighted card is the walked car, and other cards are matched to walked cars by year, manufacturer and name.
 * Each field is compared with garage.json where the walk recorded it.
 *
 * Usage: node src\cli\validate-card-pages.ts <garage directory>...
 */
const directories = process.argv.slice(2);
if (!directories.length) throw new Error("Usage: validate-card-pages.ts <garage directory>...");

const fields = ["name", "year", "manufacturer", "class/PI", "drivetrain", "tires"] as const;
type Field = typeof fields[number];
type Tally = { compared: number; correct: number; wrong: number; unread: number };
const tallies = (): Record<Field, Tally> =>
	Object.fromEntries(fields.map((field) => [field, { compared: 0, correct: 0, wrong: 0, unread: 0 }])) as Record<Field, Tally>;
const all = tallies();
const highlighted = tallies();
const mistakes: string[] = [];
const rarities = new Map<string, Set<string>>();
let cardsRead = 0;
const unmatched = new Map<string, number>();

function fieldValues(card: CardReading, car: GarageCar): Record<Field, [unknown, unknown]> {
	return {
		name: [card.car?.name ?? null, car.car?.name ?? null],
		year: [card.car?.year ?? null, car.car?.year ?? null],
		manufacturer: [card.car?.manufacturer ?? null, car.car?.manufacturer ?? null],
		"class/PI": [card.performance ? `${card.performance.class} ${card.performance.pi}` : null,
			car.performance ? `${car.performance.class} ${car.performance.pi}` : null],
		drivetrain: [card.drivetrain, car.drivetrain],
		tires: [card.tires, car.tires],
	};
}

/** A cut-off name or manufacturer is correct when the walk's reading starts with it. */
function sameText(read: string, truth: string, complete: boolean): boolean {
	return complete ? read === truth : truth.startsWith(read);
}

function matchCar(card: CardReading, cars: GarageCar[]): GarageCar | undefined {
	if (!card.car) return undefined;
	const candidates = cars.filter((car) => car.car && car.car.year === card.car!.year &&
		sameText(card.car!.manufacturer, car.car.manufacturer, card.nameComplete) && sameText(card.car!.name, car.car.name, card.nameComplete));
	return candidates.length === 1 ? candidates[0] : undefined;
}

const [worker, shapeWorker] = await Promise.all([createLocalOCRWorker(), createLocalOCRWorker("legacy")]);
try {
	const templates = await loadIconTemplates();
	for (const directory of directories) {
		const { cars } = JSON.parse(await readFile(join(directory, "garage.json"), "utf8")) as { cars: GarageCar[] };
		const screenshots = (await readdir(directory)).filter((file) => /^car-\d+-\d\.png$/.test(file)).sort();
		for (const screenshot of screenshots) {
			const { cards } = await readCardPage(await readFile(join(directory, screenshot)), worker, shapeWorker, templates);
			cardsRead += cards.length;
			for (const card of cards) {
				const car = card.selected ? cars.find((walked) => walked.screenshots.captures.includes(screenshot)) : matchCar(card, cars);
				if (!car) {
					const label = card.car ? `${card.car.year} ${card.car.manufacturer} ${card.car.name}` : "unreadable identity";
					unmatched.set(label, (unmatched.get(label) ?? 0) + 1);
					continue;
				}
				const key = `#${car.index}`;
				if (!rarities.has(key)) rarities.set(key, new Set());
				rarities.get(key)!.add(String(card.rarity));
				for (const [field, [read, truth]] of Object.entries(fieldValues(card, car)) as Array<[Field, [unknown, unknown]]>) {
					if (truth === null) continue;
					for (const tally of card.selected ? [all[field], highlighted[field]] : [all[field]]) {
						tally.compared++;
						const correct = read !== null && (typeof read === "string" && typeof truth === "string" && (field === "name" || field === "manufacturer")
							? sameText(read, truth, card.nameComplete) : read === truth);
						if (read === null) tally.unread++;
						else if (correct) tally.correct++;
						else tally.wrong++;
					}
					if (read !== null && read !== truth && !(typeof read === "string" && typeof truth === "string" &&
						(field === "name" || field === "manufacturer") && sameText(read, truth, card.nameComplete))) {
						mistakes.push(`${screenshot} column ${card.column + 1} row ${card.row + 1}${card.selected ? " (highlighted)" : ""}: ${field} read ${JSON.stringify(read)}, walk ${JSON.stringify(truth)}`);
					}
				}
			}
			console.error(`${screenshot}: ${cards.length} cards`);
		}
	}
} finally {
	await Promise.all([worker.terminate(), shapeWorker.terminate()]);
}

const table = (title: string, rows: Record<Field, Tally>) => {
	console.log(`\n${title}\nfield         compared  correct  wrong  unread  accuracy`);
	for (const field of fields) {
		const { compared, correct, wrong, unread } = rows[field];
		console.log(`${field.padEnd(14)}${String(compared).padStart(8)}${String(correct).padStart(9)}${String(wrong).padStart(7)}${String(unread).padStart(8)}` +
			`${compared ? `${(correct / compared * 100).toFixed(1)}%`.padStart(10) : "         -"}`);
	}
};
console.log(`Cards read: ${cardsRead}; matched to walked cars: ${cardsRead - [...unmatched.values()].reduce((sum, count) => sum + count, 0)}.`);
table("All matched cards (unread = left null and flagged)", all);
table("Highlighted cards only (matched by position, not by OCR)", highlighted);
console.log("\nRarity readings per walked car (no walk ground truth; one value means consistent):");
for (const [key, values] of rarities) console.log(`  ${key}: ${[...values].join(", ")}`);
console.log(`\nMismatches:${mistakes.length ? "" : " none"}`);
for (const mistake of mistakes) console.log(`  ${mistake}`);
console.log("\nCards not matched to a walked car:");
for (const [label, count] of unmatched) console.log(`  ${label} x${count}`);
