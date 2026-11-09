import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createLocalOCRWorker } from "../ocr/ocr.ts";
import { extractCarPerformance } from "../ocr/car-performance.ts";
import { defaultScreenshotsDirectory } from "../workflows/run-directory.ts";
import { BrowserRecording, parseRecordingCommand } from "../capture/browser-recording.ts";
import { defaultGarageWalkKeys, hasTileBelow, isDirectlyBelow, isSamePanel, isSameSelection, saveGarageManifest, selectionTop, walkGarage } from "../capture/garage-walk.ts";
import type { GarageCar } from "../capture/garage-walk.ts";
import { isSameScreen, pageGarage, saveGaragePagesManifest } from "../capture/garage-pages.ts";
import type { GarageCard, GaragePage } from "../capture/garage-pages.ts";
import { findCards, loadIconTemplates, readCardPage } from "../ocr/my-cars-cards.ts";
import { matchCatalog } from "../ocr/card-catalog.ts";
import { loadCarIdData } from "@forzagarage/car-ids";
import { checkGameFrame, cropToGame, readWidth, scaleToReadWidth } from "../capture/game-frame.ts";
import { assertSignedIn } from "../capture/session-check.ts";
import { listDisplays, pickDisplay } from "../capture/displays.ts";
import { setTimeout as wait } from "node:timers/promises";
import { captureStreamFrame, describeStreamStats, readStreamStats, streamInitScript } from "../capture/stream-frame.ts";
import type { StreamStats } from "../capture/stream-frame.ts";
import { connectStreamWindow, openStreamWindow, streamWindowPorts } from "../capture/stream-window.ts";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		image: { type: "string" },
		login: { type: "boolean", default: false },
		record: { type: "boolean", default: false },
		walk: { type: "boolean", default: false },
		pages: { type: "boolean", default: false },
		"max-pages": { type: "string", default: "1000" },
		"max-cars": { type: "string", default: "2000" },
		"settle-ms": { type: "string", default: "1200" },
		"read-during": { type: "boolean", default: false },
		display: { type: "string", default: "internal" },
		source: { type: "string", default: "video" },
		"keep-open": { type: "boolean", default: false },
	},
});
const provider = positionals[0] ?? "geforce";
const maxCars = Number(values["max-cars"]);
const maxPages = Number(values["max-pages"]);
const settleMs = Number(values["settle-ms"]);
if (positionals.length > 1 || values.image?.trim() === "" ||
	[values.login, values.record, values.walk, values.pages, values.image !== undefined].filter(Boolean).length > 1 ||
	!["video", "screen"].includes(values.source!) ||
	!Number.isSafeInteger(maxCars) || maxCars < 1 || !Number.isSafeInteger(maxPages) || maxPages < 1 || !Number.isSafeInteger(settleMs) || settleMs < 100 || settleMs > 10000) {
	throw new Error("Usage: cloud-capture.ts [geforce|xbox] [--display internal|primary|n] [--source video|screen] [--keep-open] [--image path | --login | --record | --walk [--max-cars n] [--settle-ms 100..10000] | --pages [--max-pages n] [--settle-ms 100..10000] [--read-during]]");
}

const urls: Record<string, string> = {
	geforce: "https://play.geforcenow.com/",
	xbox: "https://www.xbox.com/play",
};

const url = urls[provider];
if (!url) {
	throw new Error("Choose either geforce or xbox.");
}

let usingScreenFallback = false;
let warnedSmallStream = false;

/**
 * The game picture. By default it is read from the stream's video at the stream's own resolution; a page screenshot
 * (capped by the window) is the fallback when no playing video is found, and the choice with --source screen.
 */
async function grab(page: import("playwright").Page): Promise<Buffer> {
	if (values.source === "video") {
		const frame = await captureStreamFrame(page);
		if (frame) {
			usingScreenFallback = false;
			const game = await cropToGame(frame);
			const width = game.readUInt32BE(16);
			if (width < readWidth && !warnedSmallStream) {
				warnedSmallStream = true;
				console.warn(`The stream is only ${width} wide, so frames are scaled up to ${readWidth} and reads may be less reliable. ` +
					"Raise the streaming resolution in the provider's settings (GeForce Now: Streaming Quality, Custom).");
			}
			return scaleToReadWidth(game);
		}
		if (!usingScreenFallback) console.warn("No playing stream video found; using a screenshot of the window instead.");
		usingScreenFallback = true;
	}
	return cropToGame(await page.screenshot());
}

/** A quick 1280-wide JPEG of the stream, only for telling whether the screen is still moving. */
async function probe(page: import("playwright").Page): Promise<Buffer> {
	if (values.source === "video") {
		const frame = await captureStreamFrame(page, { width: 1280, type: "jpeg" });
		if (frame) return cropToGame(frame);
	}
	return grab(page);
}

/** Prints where captures come from and what the stream delivers, before a run starts. */
async function reportStream(page: import("playwright").Page): Promise<void> {
	const stats = await readStreamStats(page);
	const frame = values.source === "video" ? await captureStreamFrame(page) : null;
	console.log(`Stream: ${stats ? describeStreamStats(stats) : "no stats available"}.`);
	if (frame) {
		const size = frame.readUInt32BE(16) + "x" + frame.readUInt32BE(20);
		console.log(`Capturing frames from the stream video at ${size}.`);
	} else console.log("Capturing screenshots of the window.");
}

async function capture(): Promise<Buffer | undefined> {
	if (values.image !== undefined) return readFile(values.image);
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) throw new Error("LOCALAPPDATA is not available.");
	const profileDirectory = join(localAppData, "fh-scanner", "browser-profiles", provider);
	const display = pickDisplay(await listDisplays(), values.display!);
	// A window left open by an earlier --keep-open run already has the stream running: use it as it is.
	const port = streamWindowPorts[provider]!;
	let browser = await connectStreamWindow(port);
	if (browser && values.login) {
		await browser.close();
		throw new Error("A stream window kept open by an earlier run is using the browser profile. Close it, then sign in.");
	}
	const reused = browser !== undefined;
	const windowArgs = [...display ? [`--window-position=${display.x},${display.y}`] : [], values.login ? "--start-maximized" : "--kiosk"];
	if (reused) console.log(`Using the stream window left open by an earlier run (debugging port ${port}).`);
	else if (display) console.log(`Opening on ${display.name}${display.internal ? " (built-in screen)" : ""}, ${display.width}x${display.height}.`);
	if (!browser && values["keep-open"]) browser = await openStreamWindow({ profileDirectory, port, args: windowArgs });
	const context = browser ? browser.contexts()[0]! : await chromium.launchPersistentContext(profileDirectory, {
		channel: "msedge",
		headless: false,
		// A fixed viewport larger than the window clips the visible page; full screen keeps the game on screen.
		viewport: null,
		// --start-fullscreen left the page about 40 px short of the screen; kiosk mode fills it, so the capture is the
		// whole screen and cropToGame trims any bars. Sign-in keeps a normal window so its pages and prompts work.
		args: windowArgs,
	});
	const prompt = createInterface({ input: stdin, output: stdout });
	try {
		const host = new URL(url!).host;
		const open = reused ? context.pages().find((tab) => URL.canParse(tab.url()) && new URL(tab.url()).host === host) : undefined;
		const page = open ?? await (async () => {
			// Registered before the player loads, so its peer connection can report stream stats. A reused window
			// already has it from the run that opened the page.
			await context.addInitScript(streamInitScript);
			const tab = context.pages()[0] ?? await context.newPage();
			await tab.goto(url!);
			return tab;
		})();
		// The profile restores earlier tabs and kiosk mode adds a blank one; kiosk shows a single tab, often not this
		// one, so the stream would run in a hidden tab behind a white screen. Keep only the tab the scanner drives.
		for (const other of context.pages()) if (other !== page) await other.close();
		await page.bringToFront();
		if (values.login) {
			await login(page, prompt, profileDirectory);
			return undefined;
		}
		if (values.walk) {
			await walk(page, prompt);
			return undefined;
		}
		if (values.pages) {
			await pages(page, prompt);
			return undefined;
		}
		if (values.record) {
			await mkdir(defaultScreenshotsDirectory, { recursive: true });
			const directory = await mkdtemp(join(defaultScreenshotsDirectory, "recording-"));
			const recording = new BrowserRecording(directory, provider, {
				capture: () => { assertSignedIn(page.url(), provider); return page.screenshot(); },
				press: async (key, holdMs) => {
					assertSignedIn(page.url(), provider);
					await page.bringToFront();
					await page.keyboard.press(key, { delay: holdMs });
				},
				wait: async (milliseconds) => { await wait(milliseconds); },
			});
			await recording.save();
			console.log(`Recording directory: ${directory}`);
			let completed = false;
			try {
				await prompt.question("Launch the game and click the stream to focus it. Hide overlays, then press Enter here to capture the initial screen. Only terminal-issued keys are recorded.");
				await recording.execute({ type: "capture", label: "initial" });
				console.log("Commands: capture [label], key p, key ArrowRight, key ArrowDown 200, wait 1500, help, done.");
				while (true) {
					const input = await prompt.question("record> ");
					let command;
					try {
						command = parseRecordingCommand(input);
					} catch (error) {
						if (!(error instanceof Error)) throw error;
						console.error(error.message);
						continue;
					}
					if (command.type === "done") { completed = true; break; }
					if (command.type === "help") {
						console.log("capture [label] saves a screen; key <key> [hold-ms] sends input then waits 500 ms; wait <ms> waits longer; done saves and closes. Use lowercase p for P.");
						continue;
					}
					await recording.execute(command);
					console.log(`Recorded ${command.type}.`);
				}
			} finally {
				await recording.finish(completed);
			}
			console.log(`Recording saved: ${join(directory, "recording.json")}`);
			return undefined;
		}
		await prompt.question("Open My Cars, select a car, show ratings or press L for details, and make the game fill the viewport (16:9). Hide overlays, then press Enter here.");
		assertSignedIn(page.url(), provider);
		return await grab(page);
	} finally {
		prompt.close();
		if (browser) {
			// Disconnects only: the window and its stream stay up for the next run.
			await browser.close();
			console.log(`The stream window stays open for the next run (it will be reused automatically). Close it with Alt+F4 when you're done.`);
		} else await context.close();
	}
}

async function login(page: import("playwright").Page, prompt: ReturnType<typeof createInterface>, profileDirectory: string): Promise<void> {
	console.log(`Sign in to ${provider} in this Edge window and finish any verification. Choose "stay signed in" or "keep me signed in" if offered, since the saved profile only keeps sessions the site marks as persistent.`);
	console.log("You can do this over a remote desktop. Don't type credentials into this terminal.");
	while (true) {
		await prompt.question("Press Enter once you are signed in and the provider's home page is showing. ");
		try {
			assertSignedIn(page.url(), provider);
			break;
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
		}
	}
	console.log(`Signed in. The session is kept in ${profileDirectory} when the browser closes. That folder holds login data: don't share or commit it.`);
}

async function walk(page: import("playwright").Page, prompt: ReturnType<typeof createInterface>): Promise<void> {
	await prompt.question("Launch the game, open My Cars, select the FIRST car (top-left), click the stream to focus it and hide overlays. Make the game fill the viewport at 16:9, then press Enter here. Don't touch the stream until the walk finishes.");
	await reportStream(page);
	await checkGameFrame(await grab(page));
	// Created after the prompt so abandoning the walk before it starts leaves no empty directory.
	await mkdir(defaultScreenshotsDirectory, { recursive: true });
	const directory = await mkdtemp(join(defaultScreenshotsDirectory, "garage-"));
	console.log(`Garage directory: ${directory}`);
	const manifest: {
		schemaVersion: number; provider: string; startedAt: string; finishedAt?: string;
		status: string; error?: string; cars: GarageCar[];
	} = { schemaVersion: 1, provider, startedAt: new Date().toISOString(), status: "walking", cars: [] };
	await saveGarageManifest(directory, manifest);
	const [worker, shapeWorker] = await Promise.all([createLocalOCRWorker(), createLocalOCRWorker("legacy")]);
	try {
		const result = await walkGarage({
			capture: async () => { assertSignedIn(page.url(), provider); return grab(page); },
			press: async (key) => {
				assertSignedIn(page.url(), provider);
				await page.bringToFront();
				await page.keyboard.press(key, { delay: 100 });
			},
			wait: async (milliseconds) => { await wait(milliseconds); },
			extract: (image) => extractCarPerformance(image, worker, shapeWorker),
			isSamePanel,
			isSameSelection,
			isDirectlyBelow,
			hasTileBelow,
			selectionTop,
			saveScreenshot: (name, image) => writeFile(join(directory, name), image, { flag: "wx" }),
			loadScreenshot: (name) => readFile(join(directory, name)),
			log: (message) => console.log(message),
		}, { keys: defaultGarageWalkKeys, settleMs, maxCars }, async (car) => {
			manifest.cars.push(car);
			await saveGarageManifest(directory, manifest);
		});
		manifest.status = result.status;
		if (result.error !== undefined) manifest.error = result.error;
	} finally {
		manifest.finishedAt = new Date().toISOString();
		if (manifest.status === "walking") manifest.status = "interrupted";
		await saveGarageManifest(directory, manifest);
		await Promise.all([worker.terminate(), shapeWorker.terminate()]);
	}
	const flagged = manifest.cars.filter((car) => car.issues.length).length;
	console.log(`Walk ${manifest.status}: ${manifest.cars.length} cars, ${flagged} need review. Saved ${join(directory, "garage.json")}`);
	if (manifest.error !== undefined) console.error(`Stopped: ${manifest.error}`);
	if (flagged || manifest.status !== "completed") process.exitCode = 1;
}

async function pages(page: import("playwright").Page, prompt: ReturnType<typeof createInterface>): Promise<void> {
	// Loaded before the prompt so missing templates fail before the game is set up.
	const templates = await loadIconTemplates();
	const catalog = loadCarIdData().cars;
	await prompt.question("Launch the game, open My Cars, select the FIRST car (top-left), click the stream to focus it and hide overlays. Make the game fill the viewport at 16:9, then press Enter here. Don't touch the stream until paging finishes.");
	await reportStream(page);
	await checkGameFrame(await grab(page));
	await mkdir(defaultScreenshotsDirectory, { recursive: true });
	const directory = await mkdtemp(join(defaultScreenshotsDirectory, "pages-"));
	console.log(`Pages directory: ${directory}`);
	const manifest: {
		schemaVersion: number; provider: string; startedAt: string; finishedAt?: string;
		status: string; error?: string; pages: GaragePage[]; cars: GarageCard[];
		/** What the stream delivered when each page was captured, to explain a page that reads badly. */
		stream: Array<{ screenshot: string; source: "video" | "screen"; stats: StreamStats | null }>;
	} = { schemaVersion: 1, provider, startedAt: new Date().toISOString(), status: "paging", pages: [], cars: [], stream: [] };
	await saveGaragePagesManifest(directory, manifest);
	const [worker, shapeWorker] = await Promise.all([createLocalOCRWorker(), createLocalOCRWorker("legacy")]);
	try {
		const result = await pageGarage({
			capture: async () => { assertSignedIn(page.url(), provider); return grab(page); },
			probe: async () => { assertSignedIn(page.url(), provider); return probe(page); },
			press: async (key) => {
				assertSignedIn(page.url(), provider);
				await page.bringToFront();
				await page.keyboard.press(key, { delay: 50 });
			},
			wait: async (milliseconds) => { await wait(milliseconds); },
			layout: findCards,
			isSameScreen,
			read: async (image) => (await readCardPage(image, worker, shapeWorker, templates)).cards.map((card) => matchCatalog(card, catalog)),
			saveScreenshot: async (name, image) => {
				await writeFile(join(directory, name), image, { flag: "wx" });
				const stats = await readStreamStats(page).catch(() => null);
				manifest.stream.push({ screenshot: name, source: usingScreenFallback || values.source === "screen" ? "screen" : "video", stats });
				if (stats) console.log(`Stream at ${name}: ${describeStreamStats(stats)}.`);
			},
			loadScreenshot: (name) => readFile(join(directory, name)),
			log: (message) => console.log(message),
		}, { right: defaultGarageWalkKeys.right, settleMs, maxPages, readAfterPaging: !values["read-during"] }, async (progress) => {
			manifest.pages = progress.pages;
			manifest.cars = progress.cars;
			await saveGaragePagesManifest(directory, manifest);
		});
		manifest.pages = result.pages;
		manifest.cars = result.cars;
		manifest.status = result.status;
		if (result.error !== undefined) manifest.error = result.error;
	} finally {
		manifest.finishedAt = new Date().toISOString();
		if (manifest.status === "paging") manifest.status = "interrupted";
		await saveGaragePagesManifest(directory, manifest);
		await Promise.all([worker.terminate(), shapeWorker.terminate()]);
	}
	const flagged = manifest.cars.filter((car) => car.issues.length).length;
	console.log(`Paging ${manifest.status}: ${manifest.pages.length} pages, ${manifest.cars.length} cars, ${flagged} need review. Saved ${join(directory, "garage-pages.json")}`);
	if (manifest.error !== undefined) console.error(`Stopped: ${manifest.error}`);
	if (flagged || manifest.status !== "completed") process.exitCode = 1;
}

async function main(): Promise<void> {
	const image = await capture();
	if (image === undefined) return;
	const capturedAt = values.image === undefined ? new Date().toISOString() : null;
	await mkdir(defaultScreenshotsDirectory, { recursive: true });
	const directory = await mkdtemp(join(defaultScreenshotsDirectory, "performance-"));
	const screenshotPath = join(directory, "car.png");
	await writeFile(screenshotPath, image);
	console.log(`Screenshot saved: ${screenshotPath}`);
	const [worker, shapeWorker] = await Promise.all([createLocalOCRWorker(), createLocalOCRWorker("legacy")]);
	try {
		const observation = await extractCarPerformance(image, worker, shapeWorker);
		const outputPath = join(directory, "performance.json");
		await writeFile(outputPath, JSON.stringify({
			schemaVersion: 1,
			provider,
			source: values.image === undefined ? "browser" : "saved-image",
			capturedAt,
			extractedAt: new Date().toISOString(),
			screenshot: "car.png",
			...observation,
		}, null, 2));
		console.log(`Performance observation saved: ${outputPath}`);
		if (observation.issues.length) {
			console.error(`Review required:\n${observation.issues.join("\n")}`);
			process.exitCode = 1;
		} else {
			console.log(JSON.stringify({ car: observation.car, panel: observation.panel, ratings: observation.ratings,
				details: observation.details, performance: observation.performance,
				drivetrain: observation.drivetrain, tires: observation.tires }, null, 2));
		}
	} finally {
		await Promise.all([worker.terminate(), shapeWorker.terminate()]);
	}
}

await main();
