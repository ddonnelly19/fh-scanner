import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import sharp from "sharp";
import { getCarTileRegions, preprocessCarTileForOCR, saveCarTiles, splitCarTiles } from "../src/capture/car-tiles.ts";
import { createLocalOCRWorker } from "../src/ocr/ocr.ts";

test("extracts exactly 15 complete color tiles in row-major order at different resolutions", async () => {
	for (const [width, height] of [[2000, 1125], [3840, 2160], [1280, 720]] as const) {
		const regions = getCarTileRegions(width, height);
		const svg = `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/>${
			regions.map((region, index) => `<rect x="${region.bounds.left}" y="${region.bounds.top}"
				width="${region.bounds.width}" height="${region.bounds.height}" fill="rgb(${index * 10},50,100)"/>`).join("")
		}</svg>`;
		const tiles = await splitCarTiles(await sharp(Buffer.from(svg)).png().toBuffer());
		assert.equal(tiles.length, 15);
		for (const [index, tile] of tiles.entries()) {
			assert.equal(tile.row, Math.floor(index / 5) + 1);
			assert.equal(tile.column, index % 5 + 1);
			const { data, info } = await sharp(tile.image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
			assert.equal(info.width, tile.bounds.width);
			assert.equal(info.height, tile.bounds.height);
			assert.deepEqual([...data.subarray(0, 3)], [index * 10, 50, 100]);
			assert.deepEqual([...data.subarray(data.length - 3)], [index * 10, 50, 100]);
		}
	}
});

test("saves uniquely named tiles, preserves the page, and preprocesses only the name/year area", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-scanner-tiles-"));
	try {
		const pagePath = join(directory, "page-001.png");
		const page = await sharp({
			create: { width: 2000, height: 1125, channels: 3, background: "red" },
		}).png().toBuffer();
		await writeFile(pagePath, page);
		const output = join(directory, "tiles");
		const tiles = await saveCarTiles(pagePath, 1, output);
		assert.equal(tiles.length, 15);
		assert.equal((await readdir(output)).length, 15);
		assert.deepEqual(await readFile(pagePath), page);
		for (const tile of tiles) {
			assert.equal(tile.path, join(output, `page-001-r${tile.row}-c${tile.column}.png`));
			const buffer = await readFile(tile.path);
			const processed = await preprocessCarTileForOCR(buffer, tile.textBounds);
			const { width, height } = await sharp(processed).metadata();
			assert.equal(width, 1040);
			assert.equal(height, Math.round(tile.textBounds.height * 1000 / tile.textBounds.width) + 40);
			assert.deepEqual(await readFile(tile.path), buffer);
		}
		await assert.rejects(saveCarTiles(pagePath, 1, output), /EEXIST/);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("invalid images and dimensions report extraction errors", async () => {
	for (const size of [0, -1, 1.5, NaN, 1]) {
		assert.throws(() => getCarTileRegions(size, 1125));
	}
	await assert.rejects(splitCarTiles(Buffer.from("not an image")));
});

test("tile OCR retains the lighter year/manufacturer line as well as the model", async () => {
	const image = await sharp(Buffer.from(`<svg width="340" height="250">
		<rect width="100%" height="100%" fill="white"/>
		<text x="20" y="210" font-family="Arial" font-size="22" fill="black">595 esseesse</text>
		<text x="20" y="235" font-family="Arial" font-size="18" fill="#888888">1968 Abarth</text>
	</svg>`)).png().toBuffer();
	const processed = await preprocessCarTileForOCR(image, { left: 10, top: 185, width: 320, height: 58 });
	const worker = await createLocalOCRWorker();
	try {
		const { data: { text } } = await worker.recognize(processed);
		assert.match(text, /595 esseesse/);
		assert.match(text, /1968 Abarth/);
	} finally {
		await worker.terminate();
	}
});
