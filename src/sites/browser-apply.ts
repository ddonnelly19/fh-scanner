import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { applyGaragePlan } from "./apply-plan.ts";
import type { GarageCar, SiteAdapter } from "./types.ts";

export async function applyWithPage(
	site: SiteAdapter, cars: readonly GarageCar[], directory: string, page: Page,
	onConfirmed: (car: GarageCar) => void,
	onResultPath: (path: string) => void = () => {},
) {
	const resultPath = join(directory, `${site.resultPrefix}-${Date.now()}-${randomUUID()}.json`);
	onResultPath(resultPath);
	site.assertReady(page.url());
	const alreadyOwned = site.loadOwnedIds ? await site.loadOwnedIds(page, cars.map((car) => car.id)) : new Set<string>();
	let posted = false;
	await applyGaragePlan(cars, site.requestDelayMs, {
		addOwned: async (car) => {
			posted = !alreadyOwned.has(car.id);
			if (!posted) return;
			site.assertReady(page.url());
			await site.addOwned(page, car.id);
		},
		persist: async (results) => { await writeFile(resultPath, `${JSON.stringify(results, null, 2)}\n`); },
		onConfirmed,
		wait: async (ms) => { if (posted) await new Promise((resolve) => setTimeout(resolve, ms)); },
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	let shareUrl: string | undefined;
	if (site.shareCollectionUrl) {
		shareUrl = await site.shareCollectionUrl(page);
		await writeFile(resultPath.replace(/\.json$/, ".url.txt"), `${shareUrl}\n`, { flag: "wx" });
	}
	return { resultPath, ...(shareUrl ? { shareUrl } : {}) };
}
