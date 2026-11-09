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
	/**
	 * True when two full captures show the same cards in the same places, judged by the cards alone. The menu's
	 * background is animated, so screens minutes apart never match as a whole; this is how a grid that wrapped back
	 * to its first page is recognised.
	 */
	sameCards?(previous: Buffer, previousLayout: CardLayout, current: Buffer, currentLayout: CardLayout): Promise<boolean>;
	/**
	 * True when the current page starts with the column that was cut off at the right edge of the previous page,
	 * false when it starts further on, null when that can't be told. Catches a key press the game took twice.
	 */
	continuesFrom?(previous: Buffer, previousLayout: CardLayout, current: Buffer, currentLayout: CardLayout): Promise<boolean | null>;
	/** Reads every fully visible card. */
	read(image: Buffer): Promise<CardReading[]>;
	saveScreenshot(name: string, image: Buffer): Promise<void>;
	loadScreenshot(name: string): Promise<Buffer>;
	log(message: string): void;
}

export interface GaragePagesOptions {
	right: string;
	/** Steps back one column when a page skipped one; defaults to ArrowLeft. */
	left?: string;
	/** Longest wait for a move to show, and then for the screen to stop changing. */
	settleMs: number;
	maxPages: number;
	/** How often the screen is checked while waiting; defaults to 100 ms. */
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

/** True when two same-sized captures show the same cards in the same slots, comparing only inside the cards. */
export async function sameCardTiles(previous: Buffer, previousLayout: CardLayout, current: Buffer, currentLayout: CardLayout): Promise<boolean> {
	const slots = (layout: CardLayout) => layout.cards.map((card) => `${card.column},${card.row},${card.selected}`).join(" ");
	if (previousLayout.columns !== currentLayout.columns || slots(previousLayout) !== slots(currentLayout)) return false;
	for (const card of previousLayout.cards) {
		// Inside the card, below the name strip, where a long highlighted name scrolls.
		const { left, top, width, height } = card.bounds;
		const region = {
			left: Math.round(left + width * 0.08), top: Math.round(top + height * 0.25),
			width: Math.round(width * 0.84), height: Math.round(height * 0.67),
		};
		if (!await sameTileContents(previous, current, region)) return false;
	}
	return true;
}

// Left edge to left edge of neighbouring card columns, as a fraction of the screen width.
const columnPitch = 664 / 3840;

function correlation(a: number[], b: number[]): number {
	let meanA = 0, meanB = 0;
	for (let i = 0; i < a.length; i++) { meanA += a[i]!; meanB += b[i]!; }
	meanA /= a.length; meanB /= a.length;
	let ab = 0, aa = 0, bb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]! - meanA, y = b[i]! - meanB;
		ab += x * y; aa += x * x; bb += y * y;
	}
	return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * True when the current page's first column is the one shown cut off and dimmed at the right edge of the previous
 * page; false when the grid moved past it. The visible part of the cut-off column is compared with the same part of
 * the first column's cards, by correlation so the dimming doesn't matter. Null when there is nothing to compare.
 */
export async function followsCutOffColumn(previous: Buffer, previousLayout: CardLayout, current: Buffer, currentLayout: CardLayout): Promise<boolean | null> {
	if (currentLayout.selectedColumn !== 0) return null;
	const lastColumn = previousLayout.cards.filter((card) => card.column === previousLayout.columns - 1);
	if (!lastColumn.length) return null;
	const [before, after] = await Promise.all([previous, current].map((image) => sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true })));
	if (before!.info.width !== after!.info.width || before!.info.height !== after!.info.height) return null;
	const width = after!.info.width;
	const cutOffLeft = Math.round(lastColumn[0]!.bounds.left + columnPitch * width);
	const scores: number[] = [];
	for (const card of currentLayout.cards.filter((slot) => slot.column === 0)) {
		const visible = Math.min(width - cutOffLeft, card.bounds.width);
		if (visible < card.bounds.width * 0.3) return null;
		// Below the name strip, where a long highlighted name scrolls, and above the rarity bar.
		const top = card.bounds.top + Math.round(card.bounds.height * 0.25);
		const a: number[] = [], b: number[] = [];
		for (let y = top; y < top + card.bounds.height * 0.6; y += 2) {
			for (let x = 0; x < visible * 0.9; x += 2) {
				a.push(before!.data[y * width + cutOffLeft + x]!);
				b.push(after!.data[y * width + card.bounds.left + x]!);
			}
		}
		scores.push(correlation(a, b));
	}
	return scores.length ? Math.max(...scores) >= 0.9 : null;
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
	const pollMs = options.pollMs ?? 100;
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
	async function move(from: Buffer, key = options.right): Promise<Buffer | null> {
		// A move that changes nothing is retried once, since streams occasionally drop a key press. Instead of a fixed
		// wait, the screen is checked every pollMs: the move counts once the screen differs from before and has
		// stopped scrolling, which on a stream usually takes well under the settle time.
		timing.moves++;
		knownComparisons = 0;
		for (let attempt = 0; attempt < 2; attempt++) {
			await timed("keys", () => actions.press(key));
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
		// Saved as soon as it is captured, so a stopped run still lists every page it took.
		await onPage({ pages, cars: sorted() });
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
		const firstImage = current;
		let layout = await actions.layout(current);
		const firstLayout = layout;
		const start = layout.cards.find((card) => card.selected);
		if (!start || start.row !== 0) throw new Error("Select a car in the top row of My Cars before paging; Right keeps the row.");
		// Grid column of the highlighted card, counted from where paging started, and the last column captured.
		let selectedColumn = 0;
		let lastColumn = -1;
		while (true) {
			if (layout.selectedColumn === null) throw new Error("Cannot find the highlighted card on the page.");
			const page = await record(current, layout, selectedColumn);
			const pageImage = current;
			const pageLayout = layout;
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
			// Back on the first page: Right on the last car wrapped to the first, so every column has been captured.
			if (actions.sameCards && await actions.sameCards(firstImage, firstLayout, current, layout)) {
				actions.log("Back at the first car: the whole garage has been paged.");
				return await finish({ status: "completed" });
			}
			// A stream can deliver one Right press twice, or a retried press can land after a slow first one, and the
			// grid then moves one column too far, skipping the column that was cut off at the right edge.
			if (actions.continuesFrom && await actions.continuesFrom(pageImage, pageLayout, current, layout) === false) {
				actions.log(`Page ${pages.length + 1} skipped a column after page ${pages.length}; stepping back one column.`);
				const back = await move(seen, options.left ?? "ArrowLeft");
				if (back) {
					const image = actions.probe ? await timed("grabs", () => actions.capture()) : back;
					const backLayout = await actions.layout(image);
					if (await actions.continuesFrom(pageImage, pageLayout, image, backLayout) !== false) {
						seen = back;
						current = image;
						layout = backLayout;
					} else {
						// Stepping back didn't find the column either, so the check can't be trusted here: go forward again.
						const forward = await move(back);
						if (forward) seen = forward;
						actions.log(`Page ${pages.length + 1} may be missing a column after page ${pages.length}.`);
					}
				}
			}
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
