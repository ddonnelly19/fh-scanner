import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { connectStreamWindow, openStreamWindow } from "../src/capture/stream-window.ts";

describe("kept-open stream window", () => {
	it("outlives the connection that opened it, page state included", async () => {
		const profileDirectory = mkdtempSync(join(tmpdir(), "fh-stream-window-"));
		const port = 9350;
		// Headless, so the test doesn't open a window; Edge is used where Playwright's Chromium isn't installed.
		const executable = existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined;
		expect(await connectStreamWindow(port)).toBeUndefined();
		const first = await openStreamWindow({ profileDirectory, port, executable, args: ["--headless=new", "--no-sandbox"] });
		try {
			const page = first.contexts()[0]!.pages()[0]!;
			await page.goto("data:text/html,<p>stream</p>");
			await page.evaluate(() => { (window as unknown as { kept: number }).kept = 42; });
			await first.close();

			const second = await connectStreamWindow(port);
			expect(second).toBeDefined();
			const again = second!.contexts()[0]!.pages()[0]!;
			expect(await again.evaluate(() => (window as unknown as { kept: number }).kept)).toBe(42);
			const session = await second!.newBrowserCDPSession();
			await session.send("Browser.close").catch(() => {});
			// Edge exits a moment after Browser.close; wait for the port to go quiet so it doesn't hold the profile.
			for (let attempt = 0; attempt < 40; attempt++) {
				const lingering = await connectStreamWindow(port);
				if (!lingering) break;
				await lingering.close();
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
		} finally {
			for (let attempt = 0; attempt < 20; attempt++) {
				try { rmSync(profileDirectory, { recursive: true, force: true }); break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
			}
		}
	}, 90000);
});
