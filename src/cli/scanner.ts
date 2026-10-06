import { providerRegistry, keyboard, Key } from "@nut-tree-fork/nut-js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createLocalOCRWorker } from "../ocr/ocr.ts";
import { captureWindowScreenshot, isSameCarPage } from "../capture/window-capture.ts";
import { parseScannerOptions, captureThenProcessPages } from "../capture/scan-pages.ts";
import { preprocessCarTileForOCR, saveCarTiles } from "../capture/car-tiles.ts";
import type { SavedCarTile } from "../capture/car-tiles.ts";
import { defaultCarMappingPath } from "../collection/car-matching.ts";
import { exportCarOrdinals } from "../workflows/export-cars.ts";
import type { CapturedCarText } from "../collection/car-matching.ts";

interface CarCardData {
	manufacturer: string;
	modelName: string;
	year: number;
	isOwned: boolean;
}

/**
 * Finds and focuses the cloud streaming client window.
 */
async function focusStreamingWindow(titleKeywords: string[] = ["Forza Horizon 6 on GeForce NOW", "Xbox Cloud Gaming", "Google Chrome"]) {
	const provider = providerRegistry.getWindow();
	const windows = await provider.getWindows();
	const titledWindows = await Promise.all(
		windows.map(async (windowHandle) => ({
			windowHandle,
			title: await provider.getWindowTitle(windowHandle),
		})),
	);
	const targetWindow = titledWindows.find(({ title }) => titleKeywords.some((keyword) => title.toLowerCase().includes(keyword.toLowerCase())));

	if (!targetWindow) {
		throw new Error(`Could not locate a streaming window matching: ${titleKeywords.join(", ")}`);
	}

	console.log(`[+] Found target window: "${targetWindow.title}"`);
	if (!(await provider.focusWindow(targetWindow.windowHandle))) {
		throw new Error(`Could not focus streaming window: "${targetWindow.title}"`);
	}

	return targetWindow.windowHandle;
}

/**
 * Captures 15-car pages, advancing down between successful captures.
 */
async function runCollectionScanner(): Promise<void> {
	const options = parseScannerOptions(process.argv.slice(2));
	await mkdir(options.screenshotDirectory, { recursive: true });
	const screenshotDirectory = await mkdtemp(join(options.screenshotDirectory, "scan-"));
	console.log(`[+] Saving cropped screenshots to: ${screenshotDirectory}`);
	const windowHandle = await focusStreamingWindow();

	// Settle system threshold layout animation states
	await new Promise((resolve) => setTimeout(resolve, 1500));

	console.log("[+] Phase 1: Capturing pages until the car grid stops changing...");
	let capturedPages = 0;
	await captureThenProcessPages({
		capturePage: async () => {
			try {
				return await captureWindowScreenshot(windowHandle);
			} catch (error) {
				throw new Error(`Capture failed; stopping. Saved screenshots remain in ${screenshotDirectory}.`, { cause: error });
			}
		},
		savePage: async (screenshotBuffer, page) => {
			console.log(`\n[~] Saving page ${page} (up to 15 cars)...`);
			try {
				const screenshotPath = join(screenshotDirectory, `page-${String(page).padStart(3, "0")}.png`);
				await writeFile(screenshotPath, screenshotBuffer, { flag: "wx" });
				console.log(`[+] Screenshot saved: ${screenshotPath}`);
				return screenshotPath;
			} catch (error) {
				throw new Error(`Capture/save failed on page ${page}; stopping without advancing the grid. Saved screenshots remain in ${screenshotDirectory}.`, { cause: error });
			}
		},
		isSamePage: isSameCarPage,
		pressDown: async () => { await keyboard.type(Key.Down); },
		wait: async (milliseconds) => { await new Promise((resolve) => setTimeout(resolve, milliseconds)); },
	}, async (paths) => {
		capturedPages = paths.length;
		console.log(`\n[+] End confirmed. All ${paths.length} screenshots saved. Phase 2: Splitting into car tiles...`);
		const tiles: SavedCarTile[] = [];
		for (const [index, screenshotPath] of paths.entries()) {
			try {
				tiles.push(...await saveCarTiles(screenshotPath, index + 1, join(screenshotDirectory, "tiles")));
			} catch (error) {
				throw new Error(`Tile extraction/save failed for ${screenshotPath}. Original screenshots retained.`, { cause: error });
			}
		}
		console.log(`[+] Saved ${tiles.length} car tiles. Phase 3: Initializing local Tesseract OCR...`);
		const cars: CapturedCarText[] = [];
		const worker = await createLocalOCRWorker();
		try {
			for (const [index, tile] of tiles.entries()) {
				console.log(`\n[~] OCR tile ${index + 1}/${tiles.length} (page ${tile.page}, row ${tile.row}, column ${tile.column})`);
				try {
					const cleanedBuffer = await preprocessCarTileForOCR(await readFile(tile.path), tile.textBounds);
					const {
						data: { text },
					} = await worker.recognize(cleanedBuffer);
					await writeFile(`${tile.path.slice(0, -4)}.txt`, text, { flag: "wx" });
					cars.push({ source: join("tiles", `${basename(tile.path, ".png")}.txt`), text });

					console.log("------------------------ SCAN DATA ------------------------");
					console.log(text.trim() || "[No crisp text identified in selection frame]");
					console.log("-----------------------------------------------------------");
				} catch (error) {
					throw new Error(`OCR/result save failed for ${tile.path}. All screenshots remain in ${screenshotDirectory}.`, { cause: error });
				}
			}
		} finally {
			await worker.terminate();
		}
		console.log("[+] Phase 4: Matching captured cars to the ordinal catalog...");
		const result = await exportCarOrdinals(cars, screenshotDirectory, { mappingPath: defaultCarMappingPath });
		console.log(`[+] Car name mapping updated: ${defaultCarMappingPath}`);
		console.log(`[+] ${result.uniqueNames} unique matched car names saved to ${join(screenshotDirectory, "ordinals.txt")}.`);
		if (result.unresolved) {
			console.warn(`[!] ${result.unresolved} unresolved cars require review: ${join(screenshotDirectory, "ordinal-review.txt")}`);
		}
	});

	console.log(`\n[+] Script execution finalized. All ${capturedPages} pages saved and processed successfully.`);
}

// Kickoff runtime scanner execution
runCollectionScanner().catch((error: unknown) => {
	console.error("[-] Scanner failed:", error);
	// Exit also stops a Tesseract thread stranded by an initialization failure.
	process.exit(1);
});
