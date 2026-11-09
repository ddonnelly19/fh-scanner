import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { isSameSelection, sameTileContents } from "./garage-walk.ts";
import type { CardLayout, CardReading } from "../ocr/my-cars-cards.ts";

export interface GaragePagesActions {
	capture(): Promise<Buffer>;
	/**
	 * A quick, smaller capture used only to see whether the screen moved or is still moving; capture() is then taken
	 * once for the page itself. Without it, capture() is used for both.
	 */
	probe?(): Promise<Buffer>;
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
	/** Longest wait for a move to show, and then for the screen to stop changing. */
	settleMs: number;
	maxPages: number;
	/** How often the screen is checked while waiting; defaults to 150 ms. */
	pollMs?: number;
	/**
	 * Reads the cards only after paging ends. Reading alongside paging finishes sooner overall, but the OCR competes
	 * with the screen checks for the CPU and slows paging down, which is the part that needs the stream left alone.
	 */
	readAfterPaging?: boolean;
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
 * Adds one page's readings to the cards read so far, keyed by grid column and row. Pages overlap only at the end of
 * the grid. A second reading of the same card replaces the first only when it is cleaner; a conflicting one is
 * reported on the card instead of picked.
 */
export function addPageReadings(cards: Map<string, GarageCard>, page: GaragePage, readings: CardReading[]): void {
	for (const { evidence: _evidence, selected: _selected, ...reading } of readings) {
		const card: GarageCard = { ...reading, column: page.firstColumn + reading.column, page: page.page, screenshot: page.screenshot };
		const key = `${card.column},${card.row}`;
		const previous = cards.get(key);
		if (!previous) cards.set(key, card);
		else if (!sameCard(previous, card)) {
			previous.issues.push(`Page ${card.page} read this card differently: ${JSON.stringify({ car: card.car, rarity: card.rarity,
				performance: card.performance, drivetrain: card.drivetrain, tires: card.tires })}.`);
		} else if (card.issues.length < previous.issues.length) cards.set(key, card);
	}
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
	let releaseReads: (() => void) | undefined;
	let reads: Promise<void> = options.readAfterPaging ? new Promise<void>((resolve) => { releaseReads = resolve; }) : Promise.resolve();
	let readError: unknown;
	const sorted = () => [...cards.values()].sort((a, b) => a.column - b.column || a.row - b.row);
	const pollMs = options.pollMs ?? 150;
	// Where each page's time goes, shown on its "Captured page" line.
	let timing = { moves: 0, checks: 0, keys: 0, waits: 0, grabs: 0, compares: 0 };
	async function timed<T>(part: "keys" | "waits" | "grabs" | "compares", work: () => Promise<T>): Promise<T> {
		const started = Date.now();
		try { return await work(); } finally { timing[part] += Date.now() - started; }
	}
	const probe = () => { timing.checks++; return timed("grabs", () => actions.probe ? actions.probe() : actions.capture()); };
	// A frame caught mid-scroll, or with a stream notice drawn over it for a moment, can lack a findable highlight:
	// the comparison is then unknown (null), which counts neither as a move nor as a settled screen. A lasting
	// problem still stops the run when the page's full capture is laid out.
	let knownComparisons = 0;
	const same = (previous: Buffer, current: Buffer) => timed("compares", () => actions.isSameScreen(previous, current)
		.then((result) => { knownComparisons++; return result; }, (): null => null));
	let pageStarted = Date.now();
	/** Presses Right and returns a probe of the settled screen, or null when Right changed nothing. */
	async function move(from: Buffer): Promise<Buffer | null> {
		// A move that changes nothing is retried once, since streams occasionally drop a key press. Instead of a fixed
		// wait, the screen is checked every pollMs: the move counts once the screen differs from before and has
		// stopped scrolling, which on a stream usually takes well under the settle time.
		timing.moves++;
		knownComparisons = 0;
		for (let attempt = 0; attempt < 2; attempt++) {
			await timed("keys", () => actions.press(options.right));
			let waited = 0;
			let current: Buffer | null = null;
			do {
				const step = Math.min(pollMs, options.settleMs - waited);
				await timed("waits", () => actions.wait(step));
				waited += step;
				const capture = await probe();
				if (await same(from, capture) === false) current = capture;
			} while (!current && waited < options.settleMs);
			if (!current) continue;
			for (let settled = 0; settled < options.settleMs; settled += pollMs) {
				await timed("waits", () => actions.wait(pollMs));
				const next = await probe();
				if (await same(current, next) === true) return next;
				current = next;
			}
			return current;
		}
		// Right changing nothing ends the grid, but only if the screen could be compared at all.
		if (!knownComparisons) throw new Error("Cannot follow the highlighted My Cars tile after a move. Hide streaming overlays and try again.");
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
		addPageReadings(cards, page, readings);
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
		const now = Date.now();
		const seconds = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)} s`;
		actions.log(`Captured page ${page.page} (${seconds(now - pageStarted)}` + (timing.moves ? `: ${timing.moves} moves, ` +
			`${timing.checks} screen checks; key presses ${seconds(timing.keys)}, waiting ${seconds(timing.waits)}, ` +
			`grabbing ${seconds(timing.grabs)}, comparing ${seconds(timing.compares)}` : "") + ").");
		pageStarted = now;
		timing = { moves: 0, checks: 0, keys: 0, waits: 0, grabs: 0, compares: 0 };
		// Chained so pages are read in order, one at a time; a failed report ends the run once paging stops.
		reads = reads.then(() => readError === undefined ? read(page) : undefined)
			.catch((error: unknown) => { readError = error; });
		return page;
	}
	async function finish(result: Omit<GaragePagesResult, "pages" | "cars">): Promise<GaragePagesResult> {
		if (releaseReads) {
			actions.log(`Paging finished; reading ${pages.length} page${pages.length === 1 ? "" : "s"}. The stream can be used again.`);
			releaseReads();
		}
		await reads;
		if (readError !== undefined && result.status !== "interrupted") {
			return { status: "interrupted", pages, cars: sorted(), error: readError instanceof Error ? readError.message : String(readError) };
		}
		return { ...result, pages, cars: sorted() };
	}
	try {
		// current is the full capture of the screen a page is read from; seen is a probe of the screen shown now.
		let current = await actions.capture();
		let seen = actions.probe ? await probe() : current;
		// Right on the last car wraps to the first, so seeing the starting screen again also ends the grid.
		const firstScreen = seen;
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
				const shown = await move(seen);
				const next = shown && await same(firstScreen, shown) === true ? null : shown;
				if (!next) {
					// The final screen is captured too, unless the grid had already stopped scrolling and it shows
					// nothing new.
					if (moved) {
						const image = actions.probe ? await actions.capture() : seen;
						const final = await actions.layout(image);
						if (final.selectedColumn !== null && selectedColumn - final.selectedColumn + final.columns - 1 > lastColumn) {
							await record(image, final, selectedColumn);
						}
					}
					return await finish({ status: "completed" });
				}
				seen = next;
				selectedColumn++;
				moved = true;
			}
			current = actions.probe ? await timed("grabs", () => actions.capture()) : seen;
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
