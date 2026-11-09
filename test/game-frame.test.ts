import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { checkGameFrame, cropToGame, sameFrame, scaleToReadWidth } from "../src/capture/game-frame.ts";

// A 16:9 "game" with a bright frame edge and a highlighted tile, placed on a black canvas of the given size.
async function streamed(canvasWidth: number, canvasHeight: number, gameWidth = 1600, gameHeight = 900): Promise<Buffer> {
	const game = await sharp(Buffer.from(
		`<svg width="${gameWidth}" height="${gameHeight}"><rect width="100%" height="100%" fill="#405060"/>` +
		`<rect x="400" y="200" width="280" height="200" fill="white" stroke="#caff00" stroke-width="4"/></svg>`,
	)).png().toBuffer();
	return sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: "black" } })
		.composite([{ input: game, left: Math.floor((canvasWidth - gameWidth) / 2), top: Math.floor((canvasHeight - gameHeight) / 2) }])
		.png().toBuffer();
}

describe("game frame", () => {
	it("crops pillarbox and letterbox bars down to the 16:9 game", async () => {
		for (const [width, height] of [[2560, 900], [1600, 1200], [1600, 900]] as const) {
			const cropped = await sharp(await cropToGame(await streamed(width, height))).metadata();
			expect([cropped.width, cropped.height]).toEqual([1600, 900]);
		}
	});
	it("crops a letterboxed frame whose top bar carries a line of stream status text", async () => {
		// garage-SXnmaM: 1920x1281 from GeForce Now, game at rows 100-1179, a status line in the top bar.
		const frame = await sharp(await streamed(1920, 1281, 1920, 1080))
			.composite([{ input: { create: { width: 600, height: 12, channels: 3, background: "#d0d0d0" } }, left: 500, top: 48 }])
			.png().toBuffer();
		const cropped = await cropToGame(frame);
		expect(await sharp(cropped).metadata()).toMatchObject({ width: 1920, height: 1080 });
		await expect(checkGameFrame(cropped)).resolves.toBeUndefined();
	});
	it("leaves a frame alone when the area beside the middle isn't black", async () => {
		const stretched = await streamed(2560, 900, 2560, 900);
		expect(await cropToGame(stretched)).toBe(stretched);
		await expect(checkGameFrame(stretched)).rejects.toThrow("2560x900, not 16:9");
	});
	it("accepts a usable frame and rejects one without a highlighted car", async () => {
		await expect(checkGameFrame(await cropToGame(await streamed(2560, 900)))).resolves.toBeUndefined();
		const blank = await sharp({ create: { width: 1600, height: 900, channels: 3, background: "#405060" } }).png().toBuffer();
		await expect(checkGameFrame(blank)).rejects.toThrow("highlighted car");
	});
	it("scales a small stream frame up to 1920 wide and leaves larger ones alone", async () => {
		// GeForce Now sent 992x620 (16:10) on a bad connection: the 16:9 game is 992x558 after cropping.
		const small = await cropToGame(await streamed(992, 620, 992, 558));
		expect(await sharp(await scaleToReadWidth(small)).metadata()).toMatchObject({ width: 1920, height: 1080 });
		const large = await streamed(2560, 1440, 2560, 1440);
		expect(await scaleToReadWidth(large)).toBe(large);
	});
	it("tells a changed menu screen from compression noise", async () => {
		const screen = await streamed(1280, 720, 1280, 720);
		const noisy = await sharp(screen).jpeg({ quality: 70 }).toBuffer();
		const changed = await sharp(screen).composite([{ input: { create: { width: 640, height: 400, channels: 3, background: "#e0e0e0" } }, left: 300, top: 150 }]).png().toBuffer();
		expect(await sameFrame(screen, noisy)).toBe(true);
		expect(await sameFrame(screen, changed)).toBe(false);
	});
});
