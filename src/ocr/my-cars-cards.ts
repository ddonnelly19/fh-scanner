import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Region } from "sharp";
import { PSM } from "tesseract.js";
import type { Worker } from "tesseract.js";
import { findSelectedTile, mergeLineSpacing, parseCarIdentity, parsePerformance } from "./car-performance.ts";
import type { CarPerformance, TextEvidence } from "./car-performance.ts";

/** One card slot of the My Cars grid. Columns count from the leftmost fully visible column. */
export interface CardSlot {
	column: number;
	row: number;
	bounds: Region;
	selected: boolean;
}

export interface CardLayout {
	/** Fully visible columns; a column cut off by the screen edge is left for the next page. */
	columns: number;
	cards: CardSlot[];
	/** Column of the highlighted card, or null when no highlight was found. */
	selectedColumn: number | null;
}

// Card rows and size as fractions of a 16:9 screen, measured on 3840x2160 captures.
const rowTops = [425 / 2160, 929 / 2160, 1433 / 2160];
const cardHeight = 487 / 2160;
const cardWidth = 646 / 3840;
// The info panel and the dimmed column scrolled off to the left end before this.
const gridLeft = 0.2;

/**
 * Finds the car cards on a My Cars screen. Cards are bright from top to bottom, while empty slots, the gaps between
 * cards and the dimmed columns at both screen edges are dark. The car picture and badges darken parts of a card,
 * so a card is a run of screen columns with a fair share of bright pixels.
 */
export async function findCards(image: Buffer): Promise<CardLayout> {
	const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	if (Math.abs(info.width / info.height - 16 / 9) > 0.03) {
		throw new Error("My Cars card reading requires a game-only 16:9 screenshot without letterboxing.");
	}
	const height = Math.round(cardHeight * info.height);
	const width = cardWidth * info.width;
	const runs: Array<{ row: number; left: number; right: number }> = [];
	for (const [row, fraction] of rowTops.entries()) {
		const top = Math.round(fraction * info.height);
		const samples: number[] = [];
		for (let y = top + Math.round(height * 0.05); y < top + height * 0.95; y += 4) samples.push(y);
		let start = -1;
		for (let x = Math.floor(info.width * gridLeft); x <= info.width; x++) {
			let bright = 0;
			if (x < info.width) {
				for (const y of samples) {
					const offset = (y * info.width + x) * info.channels;
					if (Math.max(data[offset]!, data[offset + 1]!, data[offset + 2]!) > 170) bright++;
				}
			}
			const card = bright > samples.length * 0.2;
			if (card && start < 0) start = x;
			if (!card && start >= 0) {
				if (x - start > width * 0.9 && x - start < width * 1.1) runs.push({ row, left: start, right: x - 1 });
				start = -1;
			}
		}
	}
	// Every column starts with a car in the top row, so top-row cards define the columns.
	const columnLefts = runs.filter((run) => run.row === 0).map((run) => run.left);
	const tolerance = info.width * 0.006;
	const columns = columnLefts.map(() => [] as typeof runs);
	for (const run of runs) {
		const column = columnLefts.findIndex((left) => Math.abs(left - run.left) <= tolerance);
		if (column >= 0) columns[column]!.push(run);
	}
	const cards: CardSlot[] = [];
	const nominal = Math.round(width);
	for (const [column, members] of columns.entries()) {
		// The glow of a nearby highlight can widen a card by a few pixels on the left, so the column takes
		// its narrowest card's edges, and a still-wide card is measured back from its right edge.
		const narrowest = members.reduce((a, b) => b.right - b.left < a.right - a.left ? b : a);
		const left = narrowest.right - narrowest.left + 1 > nominal + 4 ? narrowest.right - nominal + 1 : narrowest.left;
		for (const run of members) {
			cards.push({
				column, row: run.row, selected: false,
				bounds: { left, top: Math.round(rowTops[run.row]! * info.height), width: narrowest.right - left + 1, height },
			});
		}
	}
	cards.sort((a, b) => a.column - b.column || a.row - b.row);
	let selectedColumn: number | null = null;
	try {
		const tile = await findSelectedTile(image);
		const centre = { x: tile.left + tile.width / 2, y: tile.top + tile.height / 2 };
		const selected = cards.find((card) => centre.x >= card.bounds.left && centre.x < card.bounds.left + card.bounds.width &&
			centre.y >= card.bounds.top && centre.y < card.bounds.top + card.bounds.height);
		if (selected) {
			selected.selected = true;
			selectedColumn = selected.column;
		}
	} catch {
		// A page without a highlight is still readable; only paging needs the highlighted column.
	}
	return { columns: columnLefts.length, cards, selectedColumn };
}

/** A card region in units of a 646x487 card, scaled to the card's size on screen. */
function cardRegion(card: Region, left: number, top: number, width: number, height: number): Region {
	const x = card.width / 646;
	const y = card.height / 487;
	return {
		left: card.left + Math.round(left * x), top: card.top + Math.round(top * y),
		width: Math.round(width * x), height: Math.round(height * y),
	};
}

export type IconKind = "drivetrain" | "tires";

export interface IconTemplate {
	kind: IconKind;
	label: string;
	/** Grayscale pixels at the 646-pixel card scale. */
	width: number;
	height: number;
	pixels: Uint8Array;
}

/** Tight icon boxes at the 646x487 card scale; matching searches a few pixels around them. */
export const iconBoxes: Record<IconKind, { left: number; top: number; width: number; height: number }> = {
	drivetrain: { left: 24, top: 349, width: 110, height: 55 },
	tires: { left: 144, top: 349, width: 64, height: 55 },
};
const iconSearchMargin = 10;

/** Grayscale pixels of a card area at the 646-pixel card scale. */
export async function cardPixels(image: Buffer, card: Region, area: { left: number; top: number; width: number; height: number }) {
	const region = cardRegion(card, area.left, area.top, area.width, area.height);
	const pixels = await sharp(image).removeAlpha().extract(region).resize(area.width, area.height, { fit: "fill" })
		.grayscale().raw().toBuffer();
	return new Uint8Array(pixels);
}

/** Normalized cross-correlation of a template placed at (dx, dy) in a larger area: 1 is identical up to brightness and contrast. */
function correlation(area: Uint8Array, areaWidth: number, template: IconTemplate, dx: number, dy: number): number {
	let sumA = 0, sumT = 0, sumAA = 0, sumTT = 0, sumAT = 0;
	const count = template.width * template.height;
	for (let y = 0; y < template.height; y++) {
		for (let x = 0; x < template.width; x++) {
			const a = area[(y + dy) * areaWidth + x + dx]!;
			const t = template.pixels[y * template.width + x]!;
			sumA += a; sumT += t; sumAA += a * a; sumTT += t * t; sumAT += a * t;
		}
	}
	const covariance = sumAT - sumA * sumT / count;
	const variance = (sumAA - sumA * sumA / count) * (sumTT - sumT * sumT / count);
	return variance <= 0 ? 0 : covariance / Math.sqrt(variance);
}

export interface IconMatch {
	label: string | null;
	score: number;
	/** Best score of a different label, to show how clear the match was. */
	runnerUp: number;
}

// The same icon scores about 0.99 across frames and card positions, while icons that differ in detail score up to
// 0.96: Slick vs Semi-Slick, AWD with the engine elsewhere, or a chunkier off-road tread against Rally.
export const iconMatchThreshold = 0.97;
export const iconMatchMargin = 0.03;

/**
 * Matches an icon area against the templates of one kind, sliding each template a few pixels to absorb
 * small layout shifts. An icon that matches nothing well, or two labels about equally, is left unknown.
 */
export function matchIcon(area: Uint8Array, areaWidth: number, areaHeight: number, templates: IconTemplate[]): IconMatch {
	const best = new Map<string, number>();
	for (const template of templates) {
		for (let dy = 0; dy + template.height <= areaHeight; dy++) {
			for (let dx = 0; dx + template.width <= areaWidth; dx++) {
				const score = correlation(area, areaWidth, template, dx, dy);
				if (score > (best.get(template.label) ?? -1)) best.set(template.label, score);
			}
		}
	}
	const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
	const [label, score] = ranked[0] ?? [null, 0];
	const runnerUp = ranked[1]?.[1] ?? 0;
	return { label: label !== null && score >= iconMatchThreshold && score - runnerUp >= iconMatchMargin ? label : null, score, runnerUp };
}

/** The card area searched for an icon: its template box plus a margin on every side. */
export function iconSearchArea(kind: IconKind) {
	const box = iconBoxes[kind];
	return {
		left: box.left - iconSearchMargin, top: box.top - iconSearchMargin,
		width: box.width + 2 * iconSearchMargin, height: box.height + 2 * iconSearchMargin,
	};
}

export async function readIcon(image: Buffer, card: Region, kind: IconKind, templates: IconTemplate[]): Promise<IconMatch> {
	const area = iconSearchArea(kind);
	return matchIcon(await cardPixels(image, card, area), area.width, area.height, templates.filter((template) => template.kind === kind));
}

/** Samples at least this similar are averaged into one template; less similar ones start another variant. */
export const iconVariantSimilarity = 0.95;

/**
 * Turns labelled icon samples (all cropped with the same box) into templates. Similar samples are averaged to
 * smooth out stream compression, and a sample unlike every template of its label becomes another variant.
 */
export function buildIconTemplates(samples: IconTemplate[]): IconTemplate[] {
	const groups: Array<{ template: IconTemplate; sum: Float64Array; count: number }> = [];
	for (const sample of samples) {
		const group = groups.find(({ template }) => template.kind === sample.kind && template.label === sample.label &&
			correlation(sample.pixels, sample.width, template, 0, 0) >= iconVariantSimilarity);
		if (group) {
			group.count++;
			for (let index = 0; index < sample.pixels.length; index++) group.sum[index]! += sample.pixels[index]!;
			group.template.pixels = Uint8Array.from(group.sum, (value) => Math.round(value / group.count));
		} else {
			groups.push({ template: { ...sample, pixels: Uint8Array.from(sample.pixels) }, sum: Float64Array.from(sample.pixels), count: 1 });
		}
	}
	return groups.map(({ template }) => template);
}

export const defaultIconDirectory =new URL("./card-icons/", import.meta.url);

/**
 * Loads icon templates saved as `<kind>-<label>-<n>.png`, where spaces in the label are written as underscores.
 * A label can have several variants, such as AWD icons with the engine at the front or in the middle.
 */
export async function loadIconTemplates(directory: string | URL = defaultIconDirectory): Promise<IconTemplate[]> {
	const templates: IconTemplate[] = [];
	for (const file of (await readdir(directory)).sort()) {
		const match = /^(drivetrain|tires)-(.+?)(?:-\d+)?\.png$/.exec(file);
		if (!match) continue;
		const path = typeof directory === "string" ? join(directory, file) : new URL(file, directory);
		const { data, info } = await sharp(await readFile(path)).grayscale().raw().toBuffer({ resolveWithObject: true });
		templates.push({ kind: match[1] as IconKind, label: match[2]!.replaceAll("_", " "), width: info.width, height: info.height, pixels: new Uint8Array(data) });
	}
	return templates;
}

export const rarities = ["COMMON", "RARE", "EPIC", "LEGENDARY"] as const;

/** Rarity by the colour of the card's rarity bar, used to cross-check the bar's text. */
export function rarityFromColour(red: number, green: number, blue: number): string | null {
	if (green > red + 40 && green > blue + 40) return "COMMON";
	if (blue > red + 60 && green > red + 30) return "RARE";
	if (red > green + 60 && blue > green + 60) return "EPIC";
	if (red > blue + 100 && green > blue + 40) return "LEGENDARY";
	return null;
}

export interface CardReading {
	column: number;
	row: number;
	selected: boolean;
	car: CarPerformance["car"];
	/** False when the name or manufacturer ends in an ellipsis, or the name scrolls on the highlighted card. */
	nameComplete: boolean;
	rarity: string | null;
	performance: CarPerformance["performance"];
	drivetrain: string | null;
	tires: string | null;
	evidence: Record<string, TextEvidence>;
	issues: string[];
}

/**
 * True when the name line has dark text near either end. Short names are centred; a long name on the highlighted
 * card scrolls inside a clip about 25 pixels in from the card edges.
 */
async function nameReachesEdges(image: Buffer, card: Region): Promise<boolean> {
	const area = { left: 0, top: 8, width: 646, height: 60 };
	const pixels = await cardPixels(image, card, area);
	const dark = (x: number) => {
		for (let y = 0; y < area.height; y++) if (pixels[y * area.width + x]! < 100) return true;
		return false;
	};
	for (let x = 10; x < 40; x++) if (dark(x) || dark(area.width - 1 - x)) return true;
	return false;
}

/**
 * Reads one card. As on the stats panel, `worker` is the LSTM recognizer and `shapeWorker` the legacy one:
 * PI digits come from the shape classifier and the LSTM reading cross-checks them.
 */
export async function readCard(image: Buffer, card: CardSlot, worker: Worker, shapeWorker: Worker, templates: IconTemplate[]): Promise<CardReading> {
	const evidence: Record<string, TextEvidence> = {};
	const issues: string[] = [];
	async function read(key: string, region: Region, mode: PSM, lightText: boolean, whitelist = "",
		scale: { height?: number; threshold?: number } = {}, engine: Worker = worker): Promise<string> {
		let crop = sharp(image).removeAlpha().extract(region)
			.resize(scale.height ? { height: scale.height } : { width: Math.max(region.width * 3, 600) })
			.grayscale();
		crop = scale.threshold ? crop.threshold(scale.threshold) : crop.normalise();
		if (lightText) crop = crop.negate();
		const prepared = await crop.png().toBuffer();
		const input = await sharp(prepared).extend({ top: 15, bottom: 15, left: 15, right: 15, background: "white" }).png().toBuffer();
		await engine.setParameters({ tessedit_pageseg_mode: mode, tessedit_char_whitelist: whitelist });
		const { data } = await engine.recognize(input);
		evidence[key] = { text: data.text.trim(), confidence: data.confidence };
		return data.text.trim();
	}
	const bounds = card.bounds;
	try {
		const titleRegion = cardRegion(bounds, 8, 6, 630, 114);
		const title = await read("car", titleRegion, PSM.SINGLE_BLOCK, false, "", { height: 150 });
		const titleSpacing = await read("carSpacing", titleRegion, PSM.SINGLE_BLOCK, false, "", {}, shapeWorker);
		let car = parseCarIdentity(mergeLineSpacing(title, titleSpacing));
		let nameComplete = true;
		if (!car) issues.push("Could not read the car's name, year and manufacturer.");
		else {
			// Text too long for the card ends in an ellipsis, which OCR reads as dots or a single glyph.
			const ellipsis = /\s*(?:\.{2,}|…|,{2,})$/;
			const name = car.name.replace(ellipsis, "");
			const manufacturer = car.manufacturer.replace(ellipsis, "");
			if (name !== car.name || manufacturer !== car.manufacturer) {
				car = { ...car, name, manufacturer };
				nameComplete = false;
				issues.push("Name or manufacturer is cut off with an ellipsis on the card.");
			} else if (card.selected && await nameReachesEdges(image, bounds)) {
				nameComplete = false;
				issues.push("Name scrolls on the highlighted card and may be cut off.");
			}
		}
		// A letter whitelist made the LSTM drop C, O and P entirely; unrestricted it reads the word, sometimes in lower case.
		const rarityText = await read("rarity", cardRegion(bounds, 16, 414, 300, 54), PSM.SINGLE_LINE, true, "",
			{ height: 100, threshold: 180 });
		const rarityWord = rarityText.toUpperCase().replace(/[^A-Z]/g, "");
		let rarity: string | null = (rarities as readonly string[]).includes(rarityWord) ? rarityWord : null;
		if (!rarity) issues.push(`Could not read rarity ("${rarityText}").`);
		const barColour = await sharp(image).removeAlpha().extract(cardRegion(bounds, 320, 420, 120, 40)).stats();
		const colourRarity = rarityFromColour(...barColour.channels.slice(0, 3).map((channel) => channel.mean) as [number, number, number]);
		if (rarity && colourRarity && colourRarity !== rarity) {
			issues.push(`Rarity text "${rarity}" doesn't match the bar colour (${colourRarity}).`);
			rarity = null;
		}
		// The class letter is white on a class-coloured badge and the PI white on black, so they are read apart.
		const performanceClass = await read("performanceClass", cardRegion(bounds, 462, 416, 60, 50), PSM.SINGLE_BLOCK, true, "DCBASRX12",
			{ height: 100, threshold: 230 });
		// Starts clear of the badge's edge, which OCR reads as a leading 1.
		const piRegion = cardRegion(bounds, 540, 416, 78, 50);
		const pi = await read("performance", piRegion, PSM.SINGLE_LINE, true, "0123456789", { height: 100 }, shapeWorker);
		const piCheck = await read("performanceCheck", piRegion, PSM.SINGLE_LINE, true, "0123456789", { height: 100 });
		const performance = parsePerformance(`${performanceClass} ${pi}`);
		if (!performance) issues.push(`Could not read class and PI ("${performanceClass}" "${pi}").`);
		else if (piCheck.replace(/\s/g, "") !== String(performance.pi)) {
			issues.push(`OCR engines disagree on PI ("${pi}" vs "${piCheck}"); kept the shape-based reading.`);
		}
		const icons: Record<IconKind, string | null> = { drivetrain: null, tires: null };
		for (const kind of ["drivetrain", "tires"] as const) {
			const match = await readIcon(image, bounds, kind, templates);
			icons[kind] = match.label;
			if (!match.label) issues.push(`Unknown ${kind} icon (best match ${match.score.toFixed(2)}, next ${match.runnerUp.toFixed(2)}).`);
		}
		for (const [field, item] of Object.entries(evidence)) {
			// A lone class letter always gets a low confidence; parsePerformance already validates it. A rarity word
			// that matched a known rarity and the bar colour is confirmed whatever its confidence.
			if (item.confidence < 60 && !["carSpacing", "performanceCheck", "performanceClass"].includes(field) &&
				!(field === "rarity" && rarity !== null)) {
				issues.push(`Low OCR confidence for ${field}: ${item.confidence.toFixed(1)}.`);
			}
		}
		return {
			column: card.column, row: card.row, selected: card.selected, car, nameComplete, rarity, performance,
			drivetrain: icons.drivetrain, tires: icons.tires, evidence, issues,
		};
	} finally {
		for (const engine of [worker, shapeWorker]) {
			await engine.setParameters({ tessedit_pageseg_mode: PSM.AUTO, tessedit_char_whitelist: "" });
		}
	}
}

/** Reads every fully visible card on a My Cars screen, column by column. */
export async function readCardPage(image: Buffer, worker: Worker, shapeWorker: Worker, templates: IconTemplate[]): Promise<{ layout: CardLayout; cards: CardReading[] }> {
	const layout = await findCards(image);
	const cards: CardReading[] = [];
	for (const card of layout.cards) cards.push(await readCard(image, card, worker, shapeWorker, templates));
	return { layout, cards };
}
