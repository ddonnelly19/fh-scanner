import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import sharp from "sharp";

export interface CarTileRegion {
	row: number;
	column: number;
	bounds: { left: number; top: number; width: number; height: number };
	textBounds: { left: number; top: number; width: number; height: number };
}

export function getCarTileRegions(width: number, height: number): CarTileRegion[] {
	if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
		throw new Error("Car tile extraction requires positive integer image dimensions.");
	}
	const regions: CarTileRegion[] = [];
	for (let row = 0; row < 3; row++) {
		for (let column = 0; column < 5; column++) {
			const left = Math.round(width * (0.067 + column * 0.171));
			const top = Math.round(height * (0.203 + row * 0.231));
			const bounds = { left, top, width: Math.round(width * 0.168), height: Math.round(height * 0.225) };
			const textBounds = {
				left: Math.round(width * (0.067 + column * 0.171 + 0.006)),
				top: Math.round(height * (0.203 + row * 0.231 + 0.171)),
				width: Math.round(width * 0.158),
				height: Math.round(height * 0.046),
			};
			if (bounds.width <= 0 || bounds.height <= 0 || textBounds.width <= 0 || textBounds.height <= 0 ||
				bounds.left + bounds.width > width || bounds.top + bounds.height > height ||
				textBounds.left < left || textBounds.top < top ||
				textBounds.left + textBounds.width > left + bounds.width ||
				textBounds.top + textBounds.height > top + bounds.height) {
				throw new Error("Image dimensions are too small for the collection grid.");
			}
			regions.push({ row: row + 1, column: column + 1, bounds, textBounds });
		}
	}
	return regions;
}

export async function splitCarTiles(pageBuffer: Buffer): Promise<Array<CarTileRegion & { image: Buffer }>> {
	const { width, height } = await sharp(pageBuffer).metadata();
	if (!width || !height) throw new Error("Cannot split a screenshot without image dimensions.");
	const tiles: Array<CarTileRegion & { image: Buffer }> = [];
	for (const region of getCarTileRegions(width, height)) {
		tiles.push({ ...region, image: await sharp(pageBuffer).extract(region.bounds).png().toBuffer() });
	}
	return tiles;
}

export interface SavedCarTile {
	page: number;
	row: number;
	column: number;
	path: string;
	textBounds: CarTileRegion["textBounds"];
}

export async function saveCarTiles(pagePath: string, page: number, outputDirectory: string): Promise<SavedCarTile[]> {
	const tiles = await splitCarTiles(await readFile(pagePath));
	await mkdir(outputDirectory, { recursive: true });
	const pageName = basename(pagePath, extname(pagePath));
	const saved: SavedCarTile[] = [];
	for (const tile of tiles) {
		const path = join(outputDirectory, `${pageName}-r${tile.row}-c${tile.column}.png`);
		await writeFile(path, tile.image, { flag: "wx" });
		saved.push({
			page, row: tile.row, column: tile.column, path,
			textBounds: {
				...tile.textBounds,
				left: tile.textBounds.left - tile.bounds.left,
				top: tile.textBounds.top - tile.bounds.top,
			},
		});
	}
	return saved;
}

export async function preprocessCarTileForOCR(tileBuffer: Buffer, textBounds: CarTileRegion["textBounds"]): Promise<Buffer> {
	return sharp(tileBuffer).extract(textBounds).grayscale().normalise().threshold(200)
		.resize({ width: 1000 }).extend({ top: 20, bottom: 20, left: 20, right: 20, background: "white" })
		.png().toBuffer();
}
