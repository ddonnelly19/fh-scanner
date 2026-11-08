import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { checkGameFrame, cropToGame } from "../src/capture/game-frame.ts";

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
});
