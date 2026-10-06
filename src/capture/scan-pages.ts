import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { defaultScreenshotsDirectory } from "../workflows/run-directory.ts";

export function parseScannerOptions(args: string[]): { screenshotDirectory: string } {
	const { values } = parseArgs({
		args,
		options: {
			"save-screenshots": { type: "boolean", default: false },
			"screenshots-dir": { type: "string" },
		},
	});
	if (values["screenshots-dir"]?.trim() === "") {
		throw new Error("--screenshots-dir must not be empty.");
	}
	return { screenshotDirectory: resolve(values["screenshots-dir"] ?? defaultScreenshotsDirectory) };
}

interface ScanPageActions {
	capturePage: () => Promise<Buffer>;
	savePage: (image: Buffer, page: number) => Promise<string>;
	isSamePage: (previous: Buffer, current: Buffer) => Promise<boolean>;
	pressDown: () => Promise<void>;
	wait: (milliseconds: number) => Promise<void>;
}

async function advancePage(downPresses: number, actions: ScanPageActions): Promise<void> {
	for (let press = 0; press < downPresses; press++) {
		await actions.pressDown();
		if (press < downPresses - 1) await actions.wait(200);
	}
	await actions.wait(1300);
}

export async function captureThenProcessPages(
	actions: ScanPageActions,
	processSavedPages: (paths: readonly string[]) => Promise<void>,
	maxPages: number = 1000,
): Promise<void> {
	if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
		throw new Error("Safety page limit must be a positive integer.");
	}
	let previous = await actions.capturePage();
	const paths = [await actions.savePage(previous, 1)];
	while (true) {
		await advancePage(paths.length === 1 ? 5 : 3, actions);
		let current = await actions.capturePage();
		if (await actions.isSamePage(previous, current)) {
			// Confirm with another Down batch in case streaming dropped input.
			await advancePage(3, actions);
			current = await actions.capturePage();
			if (await actions.isSamePage(previous, current)) {
				await processSavedPages(paths);
				return;
			}
		}
		if (paths.length >= maxPages) {
			throw new Error(`Reached the safety limit of ${maxPages} pages without detecting the end. Screenshots retained; OCR not started.`);
		}
		paths.push(await actions.savePage(current, paths.length + 1));
		previous = current;
	}
}
