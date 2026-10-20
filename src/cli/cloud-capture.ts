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
import { setTimeout as wait } from "node:timers/promises";

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: { image: { type: "string" }, record: { type: "boolean", default: false } },
});
const provider = positionals[0] ?? "geforce";
if (positionals.length > 1 || values.image?.trim() === "" || (values.record && values.image !== undefined)) {
	throw new Error("Usage: cloud-capture.ts [geforce|xbox] [--image path | --record]");
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
		viewport: { width: 1920, height: 1080 },
	});
	const prompt = createInterface({ input: stdin, output: stdout });
	try {
		const page = context.pages()[0] ?? await context.newPage();
		await page.goto(url!);
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
		await prompt.question("Open My Cars, select a car, show ratings or press P for details, and make the game fill the viewport (16:9). Hide overlays, then press Enter here.");
		return await page.screenshot();
	} finally {
		prompt.close();
		await context.close();
	}
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
	const worker = await createLocalOCRWorker();
	try {
		const observation = await extractCarPerformance(image, worker);
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
		await worker.terminate();
	}
}

await main();
