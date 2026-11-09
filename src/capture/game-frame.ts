import sharp from "sharp";
import { findSelectedTile } from "../ocr/car-performance.ts";

const gameAspect = 16 / 9;
const tolerance = 0.03;

async function isMostlyBlack(image: Buffer, region: { left: number; top: number; width: number; height: number }): Promise<boolean> {
	if (region.width <= 0 || region.height <= 0) return true;
	const pixels = await sharp(image).removeAlpha().extract(region).grayscale().raw().toBuffer();
	let bright = 0;
	for (const value of pixels) if (value > 24) bright++;
	// GeForce Now can draw a line of status text in the bar above the game (about 3% of the bar's pixels on a
	// 1920x1281 capture), so a bar only has to be mostly black. A game stretched over the bar is far brighter.
	return bright / pixels.length < 0.05;
}

/**
 * Crops the black bars a stream adds when the window isn't 16:9. GeForce Now and Xbox Cloud centre the game,
 * so the 16:9 area is taken from the middle, and only when the bars beside it are (mostly) black.
 */
export async function cropToGame(image: Buffer): Promise<Buffer> {
	const { width, height } = await sharp(image).metadata();
	if (!width || !height || Math.abs(width / height - gameAspect) <= tolerance) return image;
	const game = width / height > gameAspect
		? { width: Math.round(height * gameAspect), height }
		: { width, height: Math.round(width / gameAspect) };
	const left = Math.floor((width - game.width) / 2);
	const top = Math.floor((height - game.height) / 2);
	const bars = width / height > gameAspect
		? [{ left: 0, top: 0, width: left, height }, { left: left + game.width, top: 0, width: width - left - game.width, height }]
		: [{ left: 0, top: 0, width, height: top }, { left: 0, top: top + game.height, width, height: height - top - game.height }];
	for (const bar of bars) if (!await isMostlyBlack(image, bar)) return image;
	return sharp(image).extract({ left, top, ...game }).png().toBuffer();
}

/** Stops a run before it starts when the capture can't be read: wrong shape, or no highlighted car. */
export async function checkGameFrame(image: Buffer): Promise<void> {
	const { width, height } = await sharp(image).metadata();
	if (!width || !height || Math.abs(width / height - gameAspect) > tolerance) {
		throw new Error(`The game picture is ${width}x${height}, not 16:9, even after cropping black bars. ` +
			"Make the game fill the screen (the capture opens in kiosk mode; if it doesn't, press F11) and try again.");
	}
	try {
		await findSelectedTile(image);
	} catch {
		throw new Error("Can't see a highlighted car. Open My Cars, select the first (top-left) car, hide overlays and try again.");
	}
}

/** The width the card and stats readers were tuned on. */
export const readWidth = 1920;

/**
 * Scales a game picture narrower than readWidth up to it. A cloud stream can drop to a small size (GeForce Now sent
 * 992x620 on a bad connection), and the readers' crops and icon templates expect at least 1920 wide.
 */
export async function scaleToReadWidth(image: Buffer): Promise<Buffer> {
	const { width } = await sharp(image).metadata();
	if (!width || width >= readWidth) return image;
	return sharp(image).resize({ width: readWidth, kernel: "lanczos3" }).png().toBuffer();
}
