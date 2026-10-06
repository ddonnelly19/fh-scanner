import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import sharp from "sharp";
import { createLocalOCRWorker } from "../src/ocr/ocr.ts";

test("local OCR initializes and recognizes English without a working-directory cache", async () => {
	const originalDirectory = process.cwd();
	const directory = await mkdtemp(join(tmpdir(), "fh-scanner-ocr-"));
	try {
		process.chdir(directory);
		const worker = await createLocalOCRWorker();
		try {
			const image = await sharp(Buffer.from(
				'<svg width="600" height="120"><rect width="100%" height="100%" fill="white"/>' +
				'<text x="20" y="80" font-family="Arial" font-size="60" fill="black">HELLO 1234</text></svg>',
			)).png().toBuffer();
			const { data: { text } } = await worker.recognize(image);
			assert.equal(text.trim(), "HELLO 1234");
			assert.deepEqual(await readdir(directory), []);
		} finally {
			await worker.terminate();
		}
	} finally {
		process.chdir(originalDirectory);
		await rm(directory, { recursive: true });
	}
});
