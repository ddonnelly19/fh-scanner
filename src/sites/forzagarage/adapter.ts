import type { Page } from "playwright";
import type { SiteAdapter } from "../types.ts";
import { forzaGarageCatalog } from "./catalog.ts";

const origin = "https://forzagarage.com";
const trackerPath = "/car-tracker/";
const storageKey = "fg-garage";

async function readOwnedIds(page: Page): Promise<string[]> {
	return page.evaluate((key) => {
		const stored = localStorage.getItem(key);
		if (stored === null) return [];
		let value: unknown;
		try {
			value = JSON.parse(stored);
		} catch {
			throw new Error("ForzaGarage tracker storage is not valid JSON; no changes were made.");
		}
		if (!Array.isArray(value) || !value.every((id: unknown) => typeof id === "string")) {
			throw new Error("ForzaGarage tracker storage has an unsupported format; no changes were made.");
		}
		return value;
	}, storageKey);
}

export const forzaGarageAdapter: SiteAdapter = {
	id: "forzagarage",
	label: "ForzaGarage",
	acceptsLegacyPlan: false,
	isValidCarId: (id) => /^[A-Za-z0-9_-]+$/.test(id),
	catalog: forzaGarageCatalog,
	planFile: "forzagarage-owned-plan.json",
	resultPrefix: "forzagarage-sync",
	loginUrl: `${origin}${trackerPath}`,
	requestDelayMs: 0,
	sessionInstructions: "ForzaGarage saves progress only in this browser. If you already have a tracker collection, open its Share my garage link in this Edge window and choose “Load this collection” before continuing. This temporary session cannot access another browser's local storage.",
	assertReady(pageUrl) {
		const url = new URL(pageUrl);
		if (url.origin !== origin || url.pathname !== trackerPath) {
			throw new Error("Return the browser to the ForzaGarage Car Tracker before applying changes.");
		}
	},
	async addOwned(page, carId) {
		this.assertReady(page.url());
		if (!this.isValidCarId(carId)) throw new Error("Invalid ForzaGarage car ID.");
		if (await page.locator("#gt-root.gt-shared").count()) {
			throw new Error("ForzaGarage is showing a shared collection. Choose Load this collection before applying the plan.");
		}

		const ownedIds = await readOwnedIds(page);
		if (ownedIds.includes(carId)) return;

		const card = page.locator(`.gt-cell[data-id="${carId}"] .car-card`).first();
		if (await card.count() === 0) {
			throw new Error(`ForzaGarage tracker does not contain car ID "${carId}".`);
		}
		if (await card.getAttribute("aria-pressed") !== "false") {
			throw new Error(`ForzaGarage car "${carId}" is not in a toggleable tracker state.`);
		}
		await card.click();
		if (await card.getAttribute("aria-pressed") !== "true") {
			throw new Error(`ForzaGarage did not confirm car "${carId}" as unlocked.`);
		}
		if (!(await readOwnedIds(page)).includes(carId)) {
			throw new Error(`ForzaGarage did not save car "${carId}" to browser storage.`);
		}
	},
	async shareCollectionUrl(page) {
		this.assertReady(page.url());
		if (await page.locator("#gt-root.gt-shared").count()) {
			throw new Error("Load the shared collection before exporting browser progress.");
		}
		const shareButton = page.locator("#gt-share-btn");
		if (await shareButton.count() !== 1) {
			throw new Error("ForzaGarage share control is missing; the collection URL could not be exported.");
		}
		await shareButton.click();
		const shareUrl = await page.locator("#gt-share-url").inputValue();
		const parsed = new URL(shareUrl);
		if (parsed.origin !== origin || parsed.pathname !== trackerPath || !/^#g=[A-Za-z0-9_-]+$/.test(parsed.hash)) {
			throw new Error("ForzaGarage returned an invalid collection share URL.");
		}
		return shareUrl;
	},
};
