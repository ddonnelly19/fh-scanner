import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import sharp from "sharp";
import { cropWindowImage, getCaptureCrop, isSameCarPage, preprocessScreenshotForOCR, selectCaptureDisplay } from "../src/capture/window-capture.ts";

const primary = { id: "primary", left: 0, top: 0, width: 2560, height: 1080 };
const leftDisplay = { id: "left", left: -3840, top: -26, width: 3840, height: 2160 };

test("page comparison ignores background and borders but detects a changed name on the last card", async () => {
	async function image(background: string, name: string, border: string = "yellow") {
		return sharp(Buffer.from(`<svg width="2000" height="1125">
			<rect width="100%" height="100%" fill="${background}"/>
			<rect x="130" y="228" width="345" height="265" fill="none" stroke="${border}" stroke-width="8"/>
			${Array.from({ length: 15 }, (_, index) => {
				const x = 2000 * (0.067 + (index % 5) * 0.171 + 0.006);
				const y = 1125 * (0.203 + Math.floor(index / 5) * 0.231 + 0.171);
				return `<rect x="${x}" y="${y}" width="316" height="52" fill="white"/>
					<text x="${x + 10}" y="${y + 25}" font-size="24" font-family="Arial">${index === 14 ? name : "Car model"}</text>`;
			}).join("")}
		</svg>`)).png().toBuffer();
	}
	const first = await image("black", "Last model");
	assert.equal(await isSameCarPage(first, first), true);
	assert.equal(await isSameCarPage(first, await image("blue", "Last model", "green")), true);
	assert.equal(await isSameCarPage(first, await image("black", "Different car")), false);
	const noise = await sharp(first).linear(0.99, 1).png().toBuffer();
	assert.equal(await isSameCarPage(first, noise), true);
	await assert.rejects(isSameCarPage(first, Buffer.from("not an image")));
});

test("selects a negative-origin monitor and translates the crop to image coordinates", () => {
	const window = { left: -3840, top: -26, width: 3840, height: 2160 };
	assert.equal(selectCaptureDisplay(window, [primary, leftDisplay]), leftDisplay);
	assert.deepEqual(getCaptureCrop(window, leftDisplay, 3840, 2160), {
		left: 0, top: 0, width: 3840, height: 2160,
	});
});

test("clips partly offscreen windows rather than shifting the full crop", () => {
	assert.deepEqual(getCaptureCrop({ left: -20, top: -10, width: 100, height: 60 }, primary, 2560, 1080), {
		left: 0, top: 0, width: 80, height: 50,
	});
	assert.deepEqual(getCaptureCrop({ left: 2500, top: 1050, width: 100, height: 60 }, primary, 2560, 1080), {
		left: 2500, top: 1050, width: 60, height: 30,
	});
});

test("maps monitor bounds to scaled screenshot pixels", () => {
	assert.deepEqual(getCaptureCrop({ left: -3640, top: 174, width: 800, height: 600 }, leftDisplay, 1920, 1080), {
		left: 100, top: 100, width: 400, height: 300,
	});
});

test("chooses the display with the largest visible portion", () => {
	const window = { left: -100, top: 0, width: 500, height: 600 };
	assert.equal(selectCaptureDisplay(window, [leftDisplay, primary]), primary);
});

test("rejects zero, invalid, and non-intersecting regions before image extraction", () => {
	assert.throws(() => selectCaptureDisplay({ ...primary, width: 0 }, [primary]), /Invalid/);
	assert.throws(() => selectCaptureDisplay({ ...primary, left: NaN }, [primary]), /Invalid/);
	assert.throws(() => selectCaptureDisplay({ ...primary, left: 10000 }, [primary]), /does not intersect/);
	assert.throws(() => selectCaptureDisplay(primary, []), /does not intersect/);
	assert.throws(() => getCaptureCrop(leftDisplay, primary, 2560, 1080), /outside/);
	assert.throws(() => getCaptureCrop(primary, primary, 0, 1080), /Invalid/);
});

test("saves an unprocessed cropped color image and preprocesses it later from disk", async () => {
	const directory = await mkdtemp(join(tmpdir(), "fh-scanner-save-"));
	try {
		const raw = await sharp({
			create: { width: 100, height: 80, channels: 3, background: { r: 200, g: 50, b: 25 } },
		}).png().toBuffer();
		const crop = { left: 10, top: 20, width: 60, height: 40 };
		const cropped = await cropWindowImage(raw, crop);
		assert.deepEqual(await readdir(directory), []);
		const filename = join(directory, "page-001.png");
		await writeFile(filename, cropped);
		const withSave = await preprocessScreenshotForOCR(await readFile(filename));
		assert.deepEqual(withSave, await preprocessScreenshotForOCR(cropped));
		const { width, height } = await sharp(withSave).metadata();
		assert.equal(width, 2000);
		assert.equal(height, 1333);
		const saved = await sharp(filename).raw().toBuffer({ resolveWithObject: true });
		assert.equal(saved.info.width, 60);
		assert.equal(saved.info.height, 40);
		assert.deepEqual([...saved.data.subarray(0, 3)], [200, 50, 25]);
		assert.deepEqual(await readdir(directory), ["page-001.png"]);
		await assert.rejects(writeFile(join(directory, "missing", "page.png"), cropped));
	} finally {
		await rm(directory, { recursive: true });
	}
});
