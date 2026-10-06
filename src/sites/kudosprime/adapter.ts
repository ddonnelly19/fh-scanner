import type { SiteAdapter } from "../types.ts";
import { kudosCatalog } from "./catalog.ts";

export function validateGarageResponse(status: number, body: string): void {
	if (status < 200 || status >= 300) {
		throw new Error(`Garage update failed: HTTP ${status}. Stop and check browser login before retrying.`);
	}
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		throw new Error("Garage update returned non-JSON data. Check browser login or site verification.");
	}
	if (typeof data !== "object" || data === null || !("success" in data) || data.success !== true) {
		throw new Error("Garage API did not confirm success. Stop and check the account in the browser.");
	}
}

export const kudosPrimeAdapter: SiteAdapter = {
	id: "kudosprime",
	label: "KudosPrime",
	acceptsLegacyPlan: true,
	isValidCarId: (id) => /^[1-9]\d*$/.test(id),
	catalog: kudosCatalog,
	planFile: "kudos-owned-plan.json",
	resultPrefix: "kudos-sync",
	loginUrl: "https://www.kudosprime.com/fh6/carlist.php",
	requestDelayMs: 500,
	assertReady(pageUrl) {
		if (new URL(pageUrl).origin !== "https://www.kudosprime.com") {
			throw new Error("Return the browser to KudosPrime before applying changes.");
		}
	},
	async addOwned(page, carId) {
		this.assertReady(page.url());
		if (!this.isValidCarId(carId)) throw new Error("Invalid KudosPrime car ID.");
		const response = await page.evaluate(async (id) => {
			const response = await fetch("/fh6/api.php?action=garage.set", {
				method: "POST",
				credentials: "same-origin",
				headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
				body: new URLSearchParams({ action: "add", set: "1", car: id }).toString(),
				signal: AbortSignal.timeout(30000),
			});
			return { status: response.status, body: await response.text() };
		}, carId);
		validateGarageResponse(response.status, response.body);
	},
};
