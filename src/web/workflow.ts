import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Page } from "playwright";
import { launchSyncBrowser } from "../sites/browser-session.ts";
import type { SyncBrowserSession } from "../sites/browser-session.ts";
import { getSiteAdapter, siteAdapters } from "../sites/registry.ts";
import type { SiteAdapter, GarageCar } from "../sites/types.ts";
import { parseGaragePlan } from "../sites/garage-plan.ts";
import { applyWithPage } from "../sites/browser-apply.ts";
import { createReviewData } from "./review-data.ts";
import { defaultScreenshotsDirectory } from "../workflows/run-directory.ts";

export type Preview = { site: string; directory: string; hash: string; cars: GarageCar[]; review: string[] };

export function confirmPreview(preview: Preview, current: Preview, confirmation: string): void {
	if (preview.site !== current.site || preview.directory !== current.directory || preview.hash !== current.hash) {
		throw new Error("The owned plan changed. Close the sync browser and preview the updated plan.");
	}
	if (confirmation !== `APPLY ${preview.cars.length}`) throw new Error(`Type APPLY ${preview.cars.length} exactly.`);
	if (!preview.cars.length) throw new Error("Owned plan is empty.");
}

export async function createWorkflow(
	initialDirectory: string, initialSite: SiteAdapter, mappingPath?: string,
	launchBrowser: (site: SiteAdapter) => Promise<SyncBrowserSession> = launchSyncBrowser,
) {
	let directory = resolve(initialDirectory);
	let site = initialSite;
	let revision = 0;
	let review: Awaited<ReturnType<typeof createReviewData>> | undefined;
	let reviewError = "";
	let child: ChildProcess | undefined;
	let browser: SyncBrowserSession | undefined;
	let page: Page | undefined;
	let pendingPreview: Preview | undefined;
	let job = { kind: "", state: "idle", log: "", error: "" };
	let sync = { state: "idle", confirmed: 0, total: 0, instructions: "", error: "", shareUrl: "", resultPath: "" };
	const runs = new Map<string, string>();
	const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
	const log = (text: string) => { job.log = (job.log + text).slice(-30000); };
	const locked = () => job.state === "running" || ["opening", "ready", "applying", "complete", "failed"].includes(sync.state);

	async function reload() {
		review = undefined;
		reviewError = "";
		try { review = await createReviewData(directory, site, mappingPath); }
		catch (error) {
			reviewError = error instanceof Error ? error.message : "Cannot load review inputs.";
			console.error("[-] Review inputs unavailable:", reviewError);
		}
		revision++;
	}

	async function listRuns() {
		runs.clear();
		runs.set(directory, directory);
		for (const parent of new Set([defaultScreenshotsDirectory, dirname(initialDirectory)])) {
			let entries;
			try { entries = await readdir(parent, { withFileTypes: true }); }
			catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
				throw error;
			}
			for (const entry of entries) {
				if (entry.isDirectory() && entry.name.startsWith("scan-")) {
					const path = resolve(parent, entry.name);
					runs.set(path, path);
				}
			}
		}
		return Promise.all([...runs.values()].map(async (path) => ({
			id: path, label: basename(path), directory: path, created: (await stat(path)).birthtimeMs,
		}))).then((items) => items.sort((a, b) => b.created - a.created));
	}

	function requireReview() {
		if (!review) throw new Error(reviewError || "Run matching and ownership OCR first.");
		return review;
	}

	async function preview(): Promise<Preview> {
		const currentReview = requireReview();
		await currentReview.assertCurrent();
		const content = await readFile(join(directory, site.planFile), "utf8");
		const value: unknown = JSON.parse(content);
		const cars = parseGaragePlan(value, site);
		const reasons = typeof value === "object" && value !== null && "review" in value && Array.isArray(value.review)
			? value.review : [];
		if (!reasons.every((reason: unknown) => typeof reason === "string")) throw new Error("Invalid review reasons in owned plan.");
		const generated = currentReview.plan();
		if (JSON.stringify(cars) !== JSON.stringify(generated.owned) ||
			JSON.stringify(reasons) !== JSON.stringify(generated.review)) {
			throw new Error("The saved plan is stale. Regenerate the owned plan before previewing or syncing.");
		}
		return { site: site.id, directory, cars, review: reasons,
			hash: createHash("sha256").update(content).digest("hex") };
	}

	async function closeSync() {
		if (sync.state === "applying") throw new Error("Sync is applying. Wait for it to stop before closing.");
		if (browser) await browser.close();
		browser = undefined; page = undefined; pendingPreview = undefined;
		sync = { state: "idle", confirmed: 0, total: 0, instructions: "", error: "", shareUrl: "", resultPath: "" };
	}

	await reload();
	return {
		async state() {
			return { directory, site: site.id, label: site.label, revision, reviewError,
				runs: await listRuns(), sites: siteAdapters.map((adapter) => ({ id: adapter.id, label: adapter.label })),
				job: { ...job }, sync: { ...sync }, locked: locked() };
		},
		get directory() { return directory; },
		get site() { return site; },
		get review() { return requireReview(); },
		assertEditable(expected: unknown) {
			if (expected !== revision) throw new Error("This page is out of date. Reload the dashboard before making changes.");
			if (locked()) throw new Error("Finish the active job or close the sync browser before editing or switching runs.");
		},
		assertRevision(expected: unknown) {
			if (expected !== revision) throw new Error("This page is out of date. Reload the dashboard.");
		},
		async select(run: string, siteId: string) {
			await listRuns();
			if (!runs.has(run)) throw new Error("Select a saved run listed by the dashboard.");
			site = getSiteAdapter(siteId); directory = runs.get(run)!;
			await reload();
		},
		async refresh() { await reload(); },
		changed() { revision++; },
		preview,
		startJob(kind: string) {
			if (kind !== "match" && kind !== "ownership") throw new Error("Unknown workflow job.");
			job = { kind, state: "running", log: "", error: "" };
			const script = fileURLToPath(new URL(`../cli/${kind === "match" ? "match-ordinals" : "review-ownership"}.ts`, import.meta.url));
			const args = ["--use-system-ca", script, "--run-dir", directory];
			if (kind === "ownership") args.push("--site", site.id);
			if (kind === "match" && mappingPath) args.push("--mapping", mappingPath);
			child = spawn(process.execPath, args, { cwd: projectRoot, shell: false, windowsHide: true });
			child.stdout?.on("data", (chunk: Buffer) => log(chunk.toString()));
			child.stderr?.on("data", (chunk: Buffer) => log(chunk.toString()));
			let spawnError = "";
			child.on("error", (error) => { spawnError = error.message; log(`${error.message}\n`); });
			child.on("close", (code) => {
				child = undefined;
				void (async () => {
					await reload();
					job.state = code === 0 && !spawnError ? "complete" : "failed";
					job.error = job.state === "failed" ? spawnError || `${kind} exited with code ${code}. See the log and inspect generated files before retrying.` : "";
				})().catch((error: unknown) => {
					job.state = "failed"; job.error = error instanceof Error ? error.message : "Job reload failed.";
					console.error("[-] Workflow job failed:", error);
				});
			});
		},
		async openSync(hash: string) {
			const current = await preview();
			if (current.hash !== hash) throw new Error("Preview the current plan before opening Edge.");
			if (!current.cars.length) throw new Error("Owned plan is empty.");
			pendingPreview = current;
			sync = { state: "opening", confirmed: 0, total: current.cars.length,
				instructions: site.sessionInstructions ?? `Log in to ${site.label} in Edge, complete verification and check the target account. Return to the site before confirming.`,
				error: "", shareUrl: "", resultPath: "" };
			try {
				browser = await launchBrowser(site);
				browser.context.on("close", () => {
					if (sync.state === "ready") { sync.state = "failed"; sync.error = "Edge was closed. No updates sent; close this sync session before retrying."; }
				});
				page = browser.context.pages()[0] ?? await browser.context.newPage();
				await page.goto(site.loginUrl, { waitUntil: "domcontentloaded" });
				sync.state = "ready";
			} catch (error) {
				sync.state = "failed"; sync.error = error instanceof Error ? error.message : "Cannot open Edge.";
				throw error;
			}
		},
		async confirmSync(confirmation: string, destinationChecked: boolean) {
			if (sync.state !== "ready" || !page || !pendingPreview) throw new Error("Open the sync browser from a plan preview first.");
			if (!destinationChecked) throw new Error("Confirm the destination account or starting collection in Edge.");
			confirmPreview(pendingPreview, await preview(), confirmation);
			site.assertReady(page.url());
			const syncPage = page;
			const cars = pendingPreview.cars;
			sync.state = "applying";
			void applyWithPage(site, cars, directory, syncPage, () => { sync.confirmed++; },
				(path) => { sync.resultPath = path; })
				.then((result) => {
					sync.resultPath = result.resultPath; sync.shareUrl = result.shareUrl ?? ""; sync.state = "complete";
				})
				.catch((error: unknown) => {
					sync.state = "failed";
					sync.error = `${error instanceof Error ? error.message : "Sync failed."} Inspect audit results and the destination before retrying; uncertain updates may have been applied. No automatic retries.`;
					console.error("[-] Browser sync failed:", error);
				});
		},
		closeSync,
		async dispose() {
			if (child) child.kill();
			if (browser) await browser.close();
		},
	};
}
