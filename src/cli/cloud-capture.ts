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
import { checkGameFrame, cropToGame } from "../capture/game-frame.ts";
import { setTimeout as wait } from "node:timers/promises";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		image: { type: "string" },
		record: { type: "boolean", default: false },
		walk: { type: "boolean", default: false },
		pages: { type: "boolean", default: false },
		"max-pages": { type: "string", default: "1000" },
		"max-cars": { type: "string", default: "2000" },
		"settle-ms": { type: "string", default: "1200" },
	},
});
const provider = positionals[0] ?? "geforce";
const maxCars = Number(values["max-cars"]);
const maxPages = Number(values["max-pages"]);
const settleMs = Number(values["settle-ms"]);
if (positionals.length > 1 || values.image?.trim() === "" ||
	[values.record, values.walk, values.pages, values.image !== undefined].filter(Boolean).length > 1 ||
	!Number.isSafeInteger(maxCars) || maxCars < 1 || !Number.isSafeInteger(maxPages) || maxPages < 1 || !Number.isSafeInteger(settleMs) || settleMs < 100 || settleMs > 10000) {
	throw new Error("Usage: cloud-capture.ts [geforce|xbox] [--image path | --record | --walk [--max-cars n] [--settle-ms 100..10000] | --pages [--max-pages n] [--settle-ms 100..10000]]");
}

const urls: Record<string, string> = {
	geforce: "https://play.geforcenow.com/",
	xbox: "https://www.xbox.com/play",
};

const url = urls[provider];
if (!url) {
	throw new Error("Choose either geforce or xbox.");
}

async function capture(): Promise<Buffer | undefined> {
	if (values.image !== undefined) return readFile(values.image);
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) throw new Error("LOCALAPPDATA is not available.");
	const profileDirectory = join(localAppData, "fh-scanner", "browser-profiles", provider);
	const context = await chromium.launchPersistentContext(profileDirectory, {
		channel: "msedge",
		headless: false,
		// A fixed viewport larger than the window clips the visible page; full screen keeps the game on screen at 16:9.
		viewport: null,
		args: ["--start-fullscreen"],
	});
	const prompt = createInterface({ input: stdin, output: stdout });
	try {
		const page = context.pages()[0] ?? await context.newPage();
		await page.goto(url!);
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
				capture: () => page.screenshot(),
				press: async (key, holdMs) => {
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
		return await cropToGame(await page.screenshot());
	} finally {
		prompt.close();
		await context.close();
	}
}

async function walk(page: import("playwright").Page, prompt: ReturnType<typeof createInterface>): Promise<void> {
	await prompt.question("Launch the game, open My Cars, select the FIRST car (top-left), click the stream to focus it and hide overlays. Make the game fill the viewport at 16:9, then press Enter here. Don't touch the stream until the walk finishes.");
	await checkGameFrame(await cropToGame(await page.screenshot()));
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
			capture: async () => cropToGame(await page.screenshot()),
			press: async (key) => {
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
	await prompt.question("Launch the game, open My Cars, select the FIRST car (top-left), click the stream to focus it and hide overlays. Make the game fill the viewport at 16:9, then press Enter here. Don't touch the stream until paging finishes.");
	await checkGameFrame(await cropToGame(await page.screenshot()));
	await mkdir(defaultScreenshotsDirectory, { recursive: true });
	const directory = await mkdtemp(join(defaultScreenshotsDirectory, "pages-"));
	console.log(`Pages directory: ${directory}`);
	const manifest: {
		schemaVersion: number; provider: string; startedAt: string; finishedAt?: string;
		status: string; error?: string; pages: GaragePage[]; cars: GarageCard[];
	} = { schemaVersion: 1, provider, startedAt: new Date().toISOString(), status: "paging", pages: [], cars: [] };
	await saveGaragePagesManifest(directory, manifest);
	const [worker, shapeWorker] = await Promise.all([createLocalOCRWorker(), createLocalOCRWorker("legacy")]);
	try {
		const result = await pageGarage({
			capture: async () => cropToGame(await page.screenshot()),
			press: async (key) => {
				await page.bringToFront();
				await page.keyboard.press(key, { delay: 100 });
			},
			wait: async (milliseconds) => { await wait(milliseconds); },
			layout: findCards,
			isSameScreen,
			read: async (image) => (await readCardPage(image, worker, shapeWorker, templates)).cards,
			saveScreenshot: (name, image) => writeFile(join(directory, name), image, { flag: "wx" }),
			loadScreenshot: (name) => readFile(join(directory, name)),
			log: (message) => console.log(message),
		}, { right: defaultGarageWalkKeys.right, settleMs, maxPages }, async (progress) => {
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
