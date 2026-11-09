import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { chromium } from "playwright";
import type { Browser } from "playwright";

/**
 * A stream window that outlives the run that opened it: Edge is started on its own with a local debugging port, and
 * each run connects to it over that port. A later run then reuses the signed-in, already-running game stream instead
 * of starting a new cloud session. Disconnecting leaves the window, its page and the page's scripts as they are.
 */

/** The local debugging port of each provider's kept-open window. */
export const streamWindowPorts: Record<string, number> = { geforce: 9333, xbox: 9334 };

const edgeLocations = [
	process.env.FH_SCANNER_EDGE,
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** Connects to a kept-open window, or returns undefined when none is listening on the port. */
export async function connectStreamWindow(port: number): Promise<Browser | undefined> {
	return chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 3000 }).catch(() => undefined);
}

/** Starts Edge on its own, so it keeps running after this process ends, and connects to it. */
export async function openStreamWindow(options: { profileDirectory: string; port: number; args: string[]; executable?: string }): Promise<Browser> {
	const executable = options.executable ?? edgeLocations.find((location) => location && existsSync(location));
	if (!executable) throw new Error("Microsoft Edge was not found. Set FH_SCANNER_EDGE to the path of msedge.exe.");
	const child = spawn(executable, [
		`--user-data-dir=${options.profileDirectory}`,
		`--remote-debugging-port=${options.port}`,
		"--no-first-run",
		"--no-default-browser-check",
		...options.args,
		"about:blank",
	], { detached: true, stdio: "ignore" });
	child.unref();
	for (let attempt = 0; attempt < 60; attempt++) {
		const browser = await connectStreamWindow(options.port);
		if (browser) return browser;
		if (child.exitCode !== null && child.exitCode !== 0) break;
		await wait(250);
	}
	throw new Error(`Edge started but its debugging port ${options.port} didn't answer. If an Edge window with this profile ` +
		"is already open without --keep-open, close it and try again.");
}
