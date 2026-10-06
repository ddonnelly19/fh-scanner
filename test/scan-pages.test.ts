import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { captureThenProcessPages, parseScannerOptions } from "../src/capture/scan-pages.ts";

function fixture(pages: string[]) {
	const events: string[] = [];
	let index = 0;
	return {
		events,
		actions: {
			capturePage: async () => {
				const page = pages[index++];
				assert.notEqual(page, undefined, "Unexpected capture");
				events.push(`capture:${page}`);
				return Buffer.from(page!);
			},
			savePage: async (image: Buffer, page: number) => {
				events.push(`save:${image.toString()}`);
				return `page-${page}.png`;
			},
			isSamePage: async (before: Buffer, after: Buffer) => before.equals(after),
			pressDown: async () => { events.push("down"); },
			wait: async (milliseconds: number) => { events.push(`wait:${milliseconds}`); },
		},
	};
}

test("continues beyond ten pages, confirms the end, and only then processes unique saved pages", async () => {
	const pages = Array.from({ length: 12 }, (_, index) => `${index + 1}`);
	const { actions, events } = fixture([...pages, "12", "12"]);
	await captureThenProcessPages(actions, async (paths) => {
		assert.equal(paths.length, 12);
		assert.equal(paths.at(-1), "page-12.png");
		events.push("ocr");
	});
	assert.equal(events.filter((event) => event.startsWith("save:")).length, 12);
	assert.equal(events.at(-1), "ocr");
	assert.equal(events.filter((event) => event === "down").length, 5 + 12 * 3);
	const firstNavigation = events.slice(2, events.indexOf("capture:2"));
	assert.deepEqual(firstNavigation, [
		"down", "wait:200", "down", "wait:200", "down", "wait:200", "down", "wait:200", "down", "wait:1300",
	]);
});

test("retries unchanged input and continues if the confirmation capture changes", async () => {
	const { actions, events } = fixture(["1", "1", "2", "2", "2"]);
	await captureThenProcessPages(actions, async (paths) => { assert.equal(paths.length, 2); });
	assert.deepEqual(events.filter((event) => event.startsWith("save:")), ["save:1", "save:2"]);
});

test("handles a single-page collection without saving duplicate end probes", async () => {
	const { actions, events } = fixture(["1", "1", "1"]);
	await captureThenProcessPages(actions, async (paths) => { assert.deepEqual(paths, ["page-1.png"]); });
	assert.equal(events.filter((event) => event.startsWith("save:")).length, 1);
});

test("capture, save, comparison, and navigation failures prevent OCR", async () => {
	for (const failure of ["capturePage", "savePage", "isSamePage", "pressDown"] as const) {
		const { actions } = fixture(["1", "2"]);
		const failingActions = { ...actions, [failure]: async () => { throw new Error("failed"); } };
		await assert.rejects(captureThenProcessPages(failingActions, async () => {
			assert.fail("OCR must not start");
		}), /failed/);
	}
});

test("safety limit fails explicitly instead of processing an incomplete collection", async () => {
	const { actions } = fixture(["1", "2", "3"]);
	await assert.rejects(captureThenProcessPages(actions, async () => {
		assert.fail("OCR must not start");
	}, 2), /safety limit/);
	for (const limit of [0, -1, 1.5, NaN]) {
		await assert.rejects(captureThenProcessPages(actions, async () => {}, limit), /positive integer/);
	}
});

test("saving is mandatory with a default or custom directory and the legacy flag is accepted", () => {
	assert.deepEqual(parseScannerOptions([]), { screenshotDirectory: resolve("screenshots") });
	assert.deepEqual(parseScannerOptions(["--save-screenshots"]), { screenshotDirectory: resolve("screenshots") });
	assert.deepEqual(parseScannerOptions(["--screenshots-dir", "captures"]), { screenshotDirectory: resolve("captures") });
	assert.throws(() => parseScannerOptions(["--screenshots-dir", ""]), /empty/);
	assert.throws(() => parseScannerOptions(["--unknown"]), /Unknown option/);
});
