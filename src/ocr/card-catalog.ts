import type { CardReading } from "./my-cars-cards.ts";

/** A car from the car-ids list: the game's car number and full name, e.g. "2024 Koenigsegg Gemera". */
export interface CatalogCar {
	ordinal: number;
	name: string;
}

/** Same rule as car-ids' normalizeName: lowercase ASCII words, so "Coupé" and "COUPE" compare equal. */
export function normalizeCarName(name: string): string {
	return name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, " ").trim();
}

const cutOffIssues = ["Name or manufacturer is cut off with an ellipsis on the card.", "Name scrolls on the highlighted card and may be cut off."];
/** Doubts about the name reads that a match against the car list settles. */
const settledByMatch = (issue: string) => cutOffIssues.includes(issue) || /^Low OCR confidence for (car|carYear):/.test(issue);

/**
 * Ties a card to a car in the car list. A complete name must match exactly. A name or manufacturer cut off on the card
 * matches the cars whose full name starts with what is shown, or, when the manufacturer is the cut-off part, the cars
 * of that year whose name starts with the shown manufacturer and ends with the shown model. Only a single candidate
 * counts; the cut-off issue and low confidence in the name reads are then dropped, since the car is known.
 */
export function matchCatalog<T extends Pick<CardReading, "car" | "nameComplete" | "issues">>(card: T, cars: readonly CatalogCar[]):
	T & { catalog: CatalogCar | null } {
	if (!card.car) return { ...card, catalog: null };
	const { year, manufacturer, name } = card.car;
	const shown = normalizeCarName(`${year} ${manufacturer} ${name}`);
	const maker = normalizeCarName(`${year} ${manufacturer}`);
	const model = normalizeCarName(name);
	let candidates = cars.filter((car) => normalizeCarName(car.name) === shown);
	if (!candidates.length && !card.nameComplete && model) {
		candidates = cars.filter((car) => {
			const full = normalizeCarName(car.name);
			return full.startsWith(shown) || (full.startsWith(maker) && full.endsWith(` ${model}`));
		});
	}
	if (candidates.length !== 1) return { ...card, catalog: null };
	return { ...card, catalog: candidates[0]!, issues: card.issues.filter((issue) => !settledByMatch(issue)) };
}
