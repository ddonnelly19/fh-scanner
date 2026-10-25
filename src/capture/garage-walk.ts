import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { Region } from "sharp";
import { findSelectedTile } from "../ocr/car-performance.ts";
import type { CarPerformance } from "../ocr/car-performance.ts";

export interface GarageWalkKeys {
	toggle: string;
	right: string;
	down: string;
	up: string;
}

// P only toggles the tile icons; L switches the stats panel between ratings and details.
export const defaultGarageWalkKeys: GarageWalkKeys = { toggle: "l", right: "ArrowRight", down: "ArrowDown", up: "ArrowUp" };

export interface GarageWalkActions {
	capture(): Promise<Buffer>;
	press(key: string): Promise<void>;
	wait(milliseconds: number): Promise<void>;
	extract(image: Buffer): Promise<CarPerformance>;
	isSameSelection(previous: Buffer, current: Buffer): Promise<boolean>;
	/** True when the highlight moved one tile down the same column, leaving the previous car in place. */
	isDirectlyBelow(previous: Buffer, current: Buffer): Promise<boolean>;
	/** Top of the highlighted tile as a fraction of the screen height. */
	selectionTop(image: Buffer): Promise<number>;
	saveScreenshot(name: string, image: Buffer): Promise<void>;
	log(message: string): void;
}

export interface GarageWalkOptions {
	keys: GarageWalkKeys;
	settleMs: number;
	maxCars: number;
}

export interface GarageCar {
	index: number;
	car: CarPerformance["car"];
	performance: CarPerformance["performance"];
	drivetrain: string | null;
	tires: string | null;
	ratings: CarPerformance["ratings"] | null;
	details: CarPerformance["details"];
	screenshots: { ratings: string | null; details: string | null; captures: string[] };
	issues: string[];
}

export interface GarageWalkResult {
	status: "completed" | "limit" | "interrupted";
	cars: GarageCar[];
	error?: string;
}

function sameIdentity(a: CarPerformance["car"], b: CarPerformance["car"]): boolean {
	return a !== null && b !== null && a.name === b.name && a.year === b.year && a.manufacturer === b.manufacturer;
}

/**
 * Merges the two My Cars panels of one car. Panel-specific fields come only from that panel;
 * shared fields must agree, otherwise the conflict is reported instead of picking one.
 */
export function mergeCarPanels(index: number, captures: Array<{ screenshot: string; observation: CarPerformance | null; error?: string }>): GarageCar {
	const issues: string[] = [];
	const observations: CarPerformance[] = [];
	for (const capture of captures) {
		if (capture.observation) observations.push(capture.observation);
		else issues.push(`${capture.screenshot}: ${capture.error ?? "extraction failed"}`);
	}
	const ratingsPanel = observations.find((observation) => observation.panel === "ratings") ?? null;
	const detailsPanel = observations.find((observation) => observation.panel === "details") ?? null;
	if (!ratingsPanel) issues.push("Ratings panel was not captured.");
	if (!detailsPanel) issues.push("Details panel was not captured.");
	function shared<T>(field: string, values: T[], equal: (a: T, b: T) => boolean): T | null {
		const known = values.filter((value) => value !== null);
		if (!known.length) return null;
		if (known.some((value) => !equal(value, known[0]!))) {
			issues.push(`Panels disagree on ${field}: ${known.map((value) => JSON.stringify(value)).join(" vs ")}.`);
			return null;
		}
		return known[0]!;
	}
	const car = shared("car", observations.map((observation) => observation.car), sameIdentity);
	const performance = shared("class/PI", observations.map((observation) => observation.performance),
		(a, b) => a!.class === b!.class && a!.pi === b!.pi);
	const drivetrain = shared("drivetrain", observations.map((observation) => observation.drivetrain), (a, b) => a === b);
	for (const observation of observations) issues.push(...observation.issues.map((issue) => `${observation.panel}: ${issue}`));
	return {
		index, car, performance, drivetrain,
		tires: ratingsPanel?.tires ?? null,
		ratings: ratingsPanel?.ratings ?? null,
		details: detailsPanel?.details ?? null,
		screenshots: {
			ratings: captures.find((capture) => capture.observation === ratingsPanel)?.screenshot ?? null,
			details: captures.find((capture) => capture.observation === detailsPanel)?.screenshot ?? null,
			captures: captures.map((capture) => capture.screenshot),
		},
		issues,
	};
}

async function tileSample(image: Buffer, tile: Region): Promise<Buffer> {
	return sharp(image).removeAlpha().extract(tile).resize(160, 120, { fit: "fill" })
		.grayscale().blur(0.8).raw().toBuffer();
}

async function sameTileContents(previous: Buffer, current: Buffer, tile: Region): Promise<boolean> {
	// Compression can shift the detected border by a few pixels, so both samples use the same region.
	const [beforePixels, afterPixels] = await Promise.all([tileSample(previous, tile), tileSample(current, tile)]);
	let totalDifference = 0;
	let changedPixels = 0;
	for (let pixel = 0; pixel < beforePixels.length; pixel++) {
		const difference = Math.abs(beforePixels[pixel]! - afterPixels[pixel]!);
		totalDifference += difference;
		if (difference > 40) changedPixels++;
	}
	// Streamed video adds compression noise, so the threshold is looser than for local captures.
	return totalDifference / beforePixels.length <= 6 && changedPixels / beforePixels.length <= 0.02;
}

/**
 * True when the highlighted tile has not moved and still shows the same car.
 * Scrolling can keep the highlight in place, so the tile contents are compared too.
 */
export async function isSameSelection(previous: Buffer, current: Buffer): Promise<boolean> {
	const [before, after] = await Promise.all([findSelectedTile(previous), findSelectedTile(current)]);
	if (Math.abs(before.left - after.left) > 6 || Math.abs(before.top - after.top) > 6) return false;
	return sameTileContents(previous, current, before);
}

/**
 * True when the highlight moved down within the same column. Down at the bottom of a short column instead
 * jumps to a lower car in the column to the left, which scrolls the grid so the previous tile changes.
 */
export async function isDirectlyBelow(previous: Buffer, current: Buffer): Promise<boolean> {
	const [before, after] = await Promise.all([findSelectedTile(previous), findSelectedTile(current)]);
	if (Math.abs(before.left - after.left) > 6 || after.top - before.top < before.height * 0.5) return false;
	// The highlight border disappears from the previous tile, so only its inside is compared.
	const inset = Math.round(before.width * 0.06);
	return sameTileContents(previous, current, {
		left: before.left + inset, top: before.top + inset, width: before.width - 2 * inset, height: before.height - 2 * inset,
	});
}

export async function selectionTop(image: Buffer): Promise<number> {
	const [tile, { height }] = await Promise.all([findSelectedTile(image), sharp(image).metadata()]);
	return tile.top / height!;
}

/**
 * Visits every car in the My Cars grid column by column. Cars are grouped by manufacturer into columns
 * that scroll horizontally, so the walk goes down each column, then right to the top of the next one.
 * At each car it captures the visible panel, toggles to the other panel and captures again.
 * A move that leaves the selection unchanged is retried once before it counts as the edge of the grid.
 */
export async function walkGarage(
	actions: GarageWalkActions,
	options: GarageWalkOptions,
	onCar: (car: GarageCar) => Promise<void>,
): Promise<GarageWalkResult> {
	const cars: GarageCar[] = [];
	const name = (index: number, capture: number) => `car-${String(index).padStart(4, "0")}-${capture}.png`;
	async function move(key: string, from: Buffer): Promise<Buffer | null> {
		for (let attempt = 0; attempt < 2; attempt++) {
			await actions.press(key);
			await actions.wait(options.settleMs);
			const current = await actions.capture();
			if (!await actions.isSameSelection(from, current)) return current;
		}
		return null;
	}
	async function observe(image: Buffer, screenshot: string) {
		await actions.saveScreenshot(screenshot, image);
		try {
			return { screenshot, observation: await actions.extract(image) };
		} catch (error) {
			return { screenshot, observation: null, error: error instanceof Error ? error.message : String(error) };
		}
	}
	async function recordCar(image: Buffer): Promise<Buffer> {
		const index = cars.length + 1;
		const first = await observe(image, name(index, 1));
		await actions.press(options.keys.toggle);
		await actions.wait(options.settleMs);
		let toggled = await actions.capture();
		let second = await observe(toggled, name(index, 2));
		// Streams occasionally drop a key press; retry the toggle once if the same panel is still showing.
		if (first.observation && second.observation && first.observation.panel === second.observation.panel) {
			await actions.press(options.keys.toggle);
			await actions.wait(options.settleMs);
			toggled = await actions.capture();
			second = await observe(toggled, name(index, 3));
		}
		const car = mergeCarPanels(index, [first, second]);
		cars.push(car);
		actions.log(`Car ${index}: ${car.car ? `${car.car.year} ${car.car.manufacturer} ${car.car.name}` : "unidentified"}` +
			(car.issues.length ? ` (${car.issues.length} issue${car.issues.length === 1 ? "" : "s"})` : ""));
		await onCar(car);
		return toggled;
	}
	/** Recovers from Down jumping to the column on the left: Right returns to the bottom of the column just walked. */
	async function returnTo(previous: Buffer): Promise<Buffer> {
		for (let attempt = 0; attempt < 2; attempt++) {
			await actions.press(options.keys.right);
			await actions.wait(options.settleMs);
			const current = await actions.capture();
			if (await actions.isSameSelection(previous, current)) return current;
		}
		throw new Error("Lost the place in the My Cars grid after Down jumped to another column.");
	}
	try {
		let current = await recordCar(await actions.capture());
		// The walk starts on the top-left car, so its tile marks the top row.
		const topRow = await actions.selectionTop(current);
		while (true) {
			if (cars.length >= options.maxCars) return { status: "limit", cars };
			const below = await move(options.keys.down, current);
			if (below && await actions.isDirectlyBelow(current, below)) {
				current = await recordCar(below);
				continue;
			}
			if (below) {
				if (await actions.selectionTop(below) <= await actions.selectionTop(current)) {
					throw new Error("Down moved the highlight somewhere unexpected; stopping instead of revisiting cars.");
				}
				current = await returnTo(current);
			}
			const right = await move(options.keys.right, current);
			if (!right) return { status: "completed", cars };
			current = right;
			// Right can land on a lower row of the next column; climb to its top before recording.
			while (Math.abs(await actions.selectionTop(current) - topRow) > 0.05) {
				const above = await move(options.keys.up, current);
				if (!above) break;
				current = above;
			}
			current = await recordCar(current);
		}
	} catch (error) {
		return { status: "interrupted", cars, error: error instanceof Error ? error.message : String(error) };
	}
}

export async function saveGarageManifest(directory: string, manifest: object): Promise<void> {
	const temporary = join(directory, "garage.json.tmp");
	await writeFile(temporary, JSON.stringify(manifest, null, 2));
	await rename(temporary, join(directory, "garage.json"));
}
