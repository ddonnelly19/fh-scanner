import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { launchSyncBrowser } from "./browser-session.ts";
import { applyWithPage } from "./browser-apply.ts";
import type { GarageCar, SiteAdapter } from "./types.ts";

export async function syncWithBrowser(site: SiteAdapter, cars: readonly GarageCar[], directory: string): Promise<void> {
	if (!cars.length) throw new Error("Owned plan is empty; nothing to sync.");
	if (!stdin.isTTY) throw new Error("Apply requires an interactive terminal for login and typed confirmation.");
	const terminal = createInterface({ input: stdin, output: stdout });
	try {
		const session = await launchSyncBrowser(site);
		try {
			const context = session.context;
			const page = context.pages()[0] ?? await context.newPage();
			await page.goto(site.loginUrl, { waitUntil: "domcontentloaded" });
			console.log(site.sessionInstructions ??
				`Log in normally in the Edge window, complete any site verification, and return to ${site.label}. No credentials or cookies are stored by this tool.`);
			await terminal.question("Press Enter when the target page and starting collection are ready. ");
			site.assertReady(page.url());
			const confirmation = await terminal.question(`Confirm the ${site.label} destination and reviewed plan. Type APPLY ${cars.length} to mark these cars owned (no removals): `);
			if (confirmation !== `APPLY ${cars.length}`) {
				console.log("[+] Cancelled. No account updates sent.");
				return;
			}
			const result = await applyWithPage(site, cars, directory, page,
				(car) => { console.log(`[+] Confirmed owned: ${car.name} (${car.id})`); },
				(path) => { console.log(`[+] Sync audit: ${path}`); });
			console.log(`[+] ${cars.length} garage additions confirmed by ${site.label}. Results: ${result.resultPath}`);
			if (result.shareUrl) {
				console.log(`[+] Shareable collection URL: ${result.shareUrl}`);
				console.log("[+] Open that URL in your regular browser and choose “Load this collection” to transfer the tracker.");
			}
			await terminal.question("Inspect the updated garage in Edge, then press Enter to close the sync session. ");
		} finally {
			await session.close();
		}
	} finally {
		terminal.close();
	}
}
