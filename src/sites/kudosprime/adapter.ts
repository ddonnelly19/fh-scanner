import type { SiteAdapter } from "../types.ts";
import { kudosCatalog } from "./catalog.ts";

const ownedListLimit = 2000;

export function validateGarageResponse(status: number, body: string): void {
	let data: unknown;
	try {
		data = JSON.parse(body);
	} catch {
		if (status >= 200 && status < 300) {
			throw new Error("Garage update returned non-JSON data. Check browser login or site verification.");
		}
	}
	const details = typeof data === "object" && data !== null
		? ["code", "message"].flatMap((key) => {
			const value = Object.getOwnPropertyDescriptor(data, key)?.value;
			return typeof value === "string" ? [value.replace(/[\r\n]/g, " ").slice(0,200)] : [];
		}).join(": ") : "";
	if (status < 200 || status >= 300) {
		throw new Error(`Garage update failed: HTTP ${status}${details ? ` (${details})` : ""}. Stop and check the account before retrying.`);
	}
	if (typeof data !== "object" || data === null || !("success" in data) || data.success !== true) {
		throw new Error(`Garage API did not confirm success${details ? ` (${details})` : ""}. Stop and check the account in the browser.`);
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
	sessionInstructions: "This dedicated Edge profile retains KudosPrime login and verification cookies locally between sessions. It does not use your regular browser profile. Complete verification, log in and check the target account before confirming. Before posting, sync reads your owned KudosPrime cars through this session and only adds missing cars. If verification keeps looping, do not apply; the site may not accept automated browsers.",
	assertReady(pageUrl) {
		if (new URL(pageUrl).origin !== "https://www.kudosprime.com") {
			throw new Error("Return the browser to KudosPrime before applying changes.");
		}
	},
	async loadOwnedIds(page, carIds) {
		this.assertReady(page.url());
		const result = await page.evaluate(async (limit) => {
			const read = async (garage: string): Promise<{ error: string } | { ids: string[] }> => {
				const response = await fetch(`/fh6/carlist.php?garage=${garage}&range=${limit}&start=0`, {
					credentials: "same-origin", signal: AbortSignal.timeout(60000),
				});
				if (!response.ok) return { error: `HTTP ${response.status}` };
				const doc = new DOMParser().parseFromString(await response.text(), "text/html");
				if (!doc.querySelector("#carlist")) return { error: "no car list (login or site verification may be required)" };
				return { ids: Array.from(doc.querySelectorAll("#carlist .car[data-carid]"), (car) => car.getAttribute("data-carid") ?? "") };
			};
			const owned = await read("y");
			if ("error" in owned) return owned;
			const missing = await read("n");
			if ("error" in missing) return missing;
			return { owned: owned.ids, missing: missing.ids };
		}, ownedListLimit) as { error: string } | { owned: string[]; missing: string[] };
		if ("error" in result) {
			throw new Error(`Cannot read KudosPrime garage: ${result.error}. No additions sent.`);
		}
		if (result.owned.length >= ownedListLimit || result.missing.length >= ownedListLimit) {
			throw new Error(`KudosPrime garage list reached ${ownedListLimit} cars and may be truncated. No additions sent.`);
		}
		if ([...result.owned, ...result.missing].some((id) => !this.isValidCarId(id))) {
			throw new Error("KudosPrime garage list contains an invalid car ID. No additions sent.");
		}
		const owned = new Set(result.owned);
		const missing = new Set(result.missing);
		if (result.owned.some((id) => missing.has(id))) {
			throw new Error("KudosPrime owned and missing lists overlap; the session may not be logged in. No additions sent.");
		}
		const unknown = carIds.filter((id) => owned.has(id) === missing.has(id));
		if (unknown.length) {
			throw new Error(`Cannot determine KudosPrime ownership for car${unknown.length > 1 ? "s" : ""} ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? ", ..." : ""}. No additions sent.`);
		}
		return owned;
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
