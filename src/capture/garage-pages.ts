import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { isSameSelection, sameTileContents } from "./garage-walk.ts";
import type { CardLayout, CardReading } from "../ocr/my-cars-cards.ts";

export interface GaragePagesActions {
	capture(): Promise<Buffer>;
	press(key: string): Promise<void>;
	wait(milliseconds: number): Promise<void>;
	/** Card positions and the highlighted column, without OCR. */
	layout(image: Buffer): Promise<CardLayout>;
	/** True when nothing moved: the same card is highlighted and the grid hasn't scrolled. */
	isSameScreen(previous: Buffer, current: Buffer): Promise<boolean>;
	/** Reads every fully visible card. */
	read(image: Buffer): Promise<CardReading[]>;
	saveScreenshot(name: string, image: Buffer): Promise<void>;
	loadScreenshot(name: string): Promise<Buffer>;
	log(message: string): void;
}

export interface GaragePagesOptions {
	right: string;
	settleMs: number;
	maxPages: number;
}

/** A card with its column counted from the first column of the whole grid. */
export interface GarageCard extends Omit<CardReading, "evidence" | "selected"> {
	page: number;
	screenshot: string;
}

export interface GaragePage {
	page: number;
	screenshot: string;
	/** Grid column shown leftmost on this page. */
	firstColumn: number;
	columns: number;
	cards: number;
	error?: string;
}

export interface GaragePagesResult {
	status: "completed" | "limit" | "interrupted";
	pages: GaragePage[];
	cars: GarageCard[];
	error?: string;
}

/** True when the highlighted card stayed put and the grid didn't scroll; a duplicate car beside it can't fool both. */
export async function isSameScreen(previous: Buffer, current: Buffer): Promise<boolean> {
	if (!await isSameSelection(previous, current)) return false;
	const { width, height } = await sharp(previous).metadata();
	return sameTileContents(previous, current, {
		left: Math.round(width! * 0.2), top: Math.round(height! * 0.19), width: Math.round(width! * 0.8), height: Math.round(height! * 0.7),
	});
}

function sameCard(a: GarageCard, b: GarageCard): boolean {
	return JSON.stringify([a.car, a.rarity, a.performance, a.drivetrain, a.tires]) ===
		JSON.stringify([b.car, b.rarity, b.performance, b.drivetrain, b.tires]);
}

/**
 * Pages through the My Cars grid one screen at a time, starting from the highlighted top-left car. Right moves the
 * highlight one column and the grid scrolls to keep it leftmost, so after each screenshot the highlight moves
 * right until it reaches the first column that wasn't fully visible. The end of the grid is where Right no longer
 * changes the screen. Cards are read from the saved screenshots in the background while paging moves on.
 */
export async function pageGarage(
	actions: GaragePagesActions,
	options: GaragePagesOptions,
	onPage: (result: { pages: GaragePage[]; cars: GarageCard[] }) => Promise<void>,
): Promise<GaragePagesResult> {
	const pages: GaragePage[] = [];
	const cards = new Map<string, GarageCard>();
	let reads: Promise<void> = Promise.resolve();
	let readError: unknown;
	const sorted = () => [...cards.values()].sort((a, b) => a.column - b.column || a.row - b.row);
	async function move(from: Buffer): Promise<Buffer | null> {
		// A move that changes nothing is retried once, since streams occasionally drop a key press.
		for (let attempt = 0; attempt < 2; attempt++) {
			await actions.press(options.right);
			await actions.wait(options.settleMs);
			const current = await actions.capture();
			if (!await actions.isSameScreen(from, current)) return current;
		}
		return null;
	}
	async function read(page: GaragePage): Promise<void> {
		let readings: CardReading[] = [];
		try {
			readings = await actions.read(await actions.loadScreenshot(page.screenshot));
		} catch (error) {
			page.error = error instanceof Error ? error.message : String(error);
		}
		page.cards = readings.length;
		for (const { evidence: _evidence, selected: _selected, ...reading } of readings) {
			const card: GarageCard = { ...reading, column: page.firstColumn + reading.column, page: page.page, screenshot: page.screenshot };
			const key = `${card.column},${card.row}`;
			const previous = cards.get(key);
			// Pages overlap only at the end of the grid. A second reading of the same card replaces the first only
			// when it is cleaner; a conflicting one is reported on the card instead of picked.
			if (!previous) cards.set(key, card);
			else if (!sameCard(previous, card)) {
				previous.issues.push(`Page ${card.page} read this card differently: ${JSON.stringify({ car: card.car, rarity: card.rarity,
					performance: card.performance, drivetrain: card.drivetrain, tires: card.tires })}.`);
			} else if (card.issues.length < previous.issues.length) cards.set(key, card);
		}
		const flagged = readings.filter((reading) => reading.issues.length).length;
		actions.log(`Page ${page.page}: ${readings.length} cards` + (flagged ? ` (${flagged} need review)` : "") +
			(page.error ? ` (failed: ${page.error})` : ""));
		await onPage({ pages, cars: sorted() });
	}
	async function record(image: Buffer, layout: CardLayout, selectedColumn: number): Promise<GaragePage> {
		const page: GaragePage = {
			page: pages.length + 1, screenshot: `page-${String(pages.length + 1).padStart(3, "0")}.png`,
			firstColumn: selectedColumn - layout.selectedColumn!, columns: layout.columns, cards: 0,
		};
		await actions.saveScreenshot(page.screenshot, image);
		pages.push(page);
		actions.log(`Captured page ${page.page}.`);
		// Chained so pages are read in order, one at a time; a failed report ends the run once paging stops.
		reads = reads.then(() => readError === undefined ? read(page) : undefined)
			.catch((error: unknown) => { readError = error; });
		return page;
	}
	async function finish(result: Omit<GaragePagesResult, "pages" | "cars">): Promise<GaragePagesResult> {
		await reads;
		if (readError !== undefined && result.status !== "interrupted") {
			return { status: "interrupted", pages, cars: sorted(), error: readError instanceof Error ? readError.message : String(readError) };
		}
		return { ...result, pages, cars: sorted() };
	}
	try {
		let current = await actions.capture();
		let layout = await actions.layout(current);
		const start = layout.cards.find((card) => card.selected);
		if (!start || start.row !== 0) throw new Error("Select a car in the top row of My Cars before paging; Right keeps the row.");
		// Grid column of the highlighted card, counted from where paging started, and the last column captured.
		let selectedColumn = 0;
		let lastColumn = -1;
		while (true) {
			if (layout.selectedColumn === null) throw new Error("Cannot find the highlighted card on the page.");
			const page = await record(current, layout, selectedColumn);
			if (pages.length >= options.maxPages) return await finish({ status: "limit" });
			const nextColumn = page.firstColumn + layout.columns;
			lastColumn = Math.max(lastColumn, nextColumn - 1);
			if (nextColumn <= selectedColumn) throw new Error("The highlighted card is not in a fully visible column.");
			let moved = false;
			while (selectedColumn < nextColumn) {
				const next = await move(current);
				if (!next) {
					// The final screen is captured too, unless the grid had already stopped scrolling and it shows
					// nothing new.
					if (moved) {
						const final = await actions.layout(current);
						if (final.selectedColumn !== null && selectedColumn - final.selectedColumn + final.columns - 1 > lastColumn) {
							await record(current, final, selectedColumn);
						}
					}
					return await finish({ status: "completed" });
				}
				current = next;
				selectedColumn++;
				moved = true;
			}
			layout = await actions.layout(current);
		}
	} catch (error) {
		return await finish({ status: "interrupted", error: error instanceof Error ? error.message : String(error) });
	}
}

export async function saveGaragePagesManifest(directory: string, manifest: object): Promise<void> {
	const temporary = join(directory, "garage-pages.json.tmp");
	await writeFile(temporary, JSON.stringify(manifest, null, 2));
	await rename(temporary, join(directory, "garage-pages.json"));
}
