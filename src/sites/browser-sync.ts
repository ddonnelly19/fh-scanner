import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium } from "playwright";
import { applyGaragePlan } from "./apply-plan.ts";
import type { GarageCar, SiteAdapter } from "./types.ts";

export async function syncWithBrowser(site: SiteAdapter, cars: readonly GarageCar[], directory: string): Promise<void> {
	if (!cars.length) throw new Error("Owned plan is empty; nothing to sync.");
	if (!stdin.isTTY) throw new Error("Apply requires an interactive terminal for login and typed confirmation.");
	const terminal = createInterface({ input: stdin, output: stdout });
	const resultPath = join(directory, `${site.resultPrefix}-${Date.now()}.json`);
	try {
		const browser = await chromium.launch({ channel: "msedge", headless: false });
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			await page.goto(site.loginUrl, { waitUntil: "domcontentloaded" });
			console.log(`[+] Log in normally in the Edge window, complete any site verification, and return to ${site.label}. No credentials or cookies are stored by this tool.`);
			await terminal.question("Press Enter when login is complete and the target account is visible. ");
			site.assertReady(page.url());
			const confirmation = await terminal.question(`Confirm the ${site.label} account and reviewed plan. Type APPLY ${cars.length} to mark these cars owned (no removals): `);
			if (confirmation !== `APPLY ${cars.length}`) {
				console.log("[+] Cancelled. No account updates sent.");
				return;
			}
			console.log(`[+] Sync results will be saved to: ${resultPath}`);
			const results = await applyGaragePlan(cars, site.requestDelayMs, {
				addOwned: async (car) => {
					site.assertReady(page.url());
					await site.addOwned(page, car.id);
				},
				persist: async (results) => { await writeFile(resultPath, `${JSON.stringify(results, null, 2)}\n`); },
				onConfirmed: (car) => { console.log(`[+] Confirmed owned: ${car.name} (${car.id})`); },
				wait: async (milliseconds) => { await new Promise((resolve) => setTimeout(resolve, milliseconds)); },
			});
			console.log(`[+] ${results.length} garage additions confirmed by ${site.label}. Results: ${resultPath}`);
			await page.reload({ waitUntil: "domcontentloaded" });
			await terminal.question("Inspect the updated garage in Edge, then press Enter to close the temporary session. ");
		} finally {
			await browser.close();
		}
	} finally {
		terminal.close();
	}
}
