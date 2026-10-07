import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { BrowserContext } from "playwright";
import type { SiteAdapter } from "./types.ts";

export interface SyncBrowserSession {
	context: BrowserContext;
	close(): Promise<void>;
}

export function kudosPrimeProfileDirectory(): string {
	return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
		"fh-scanner", "browser-profiles", "kudosprime");
}

export async function launchSyncBrowser(site: SiteAdapter): Promise<SyncBrowserSession> {
	if (site.id === "kudosprime") {
		const directory = kudosPrimeProfileDirectory();
		let context: BrowserContext;
		try {
			context = await chromium.launchPersistentContext(directory, {
				channel: "msedge", headless: false,
				ignoreDefaultArgs: ["--enable-automation"],
				args: ["--disable-blink-features=AutomationControlled"],
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Cannot open the dedicated KudosPrime Edge profile at ${directory}. Close any other scanner session using this profile before retrying. ${message}`, { cause: error });
		}
		try {
			await context.addInitScript(() => {
				Object.defineProperty(navigator, "webdriver", { get: () => undefined });
			});
		} catch (error) {
			await context.close();
			throw error;
		}
		return { context, close: () => context.close() };
	}
	const browser = await chromium.launch({ channel: "msedge", headless: false });
	try {
		const context = await browser.newContext();
		return { context, close: () => browser.close() };
	} catch (error) {
		await browser.close();
		throw error;
	}
}
