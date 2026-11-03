import { readdir, stat } from "node:fs/promises";
import { dirname, resolve, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createReviewData } from "./review-data.ts";
import { defaultScreenshotsDirectory } from "../workflows/run-directory.ts";
import { ownedCarsFile } from "../workflows/owned-cars.ts";

export async function createWorkflow(initialDirectory: string, mappingPath?: string) {
	let directory = resolve(initialDirectory);
	let revision = 0;
	let review: Awaited<ReturnType<typeof createReviewData>> | undefined;
	let reviewError = "";
	let child: ChildProcess | undefined;
	let job = { kind: "", state: "idle", log: "", error: "" };
	const runs = new Map<string, string>();
	const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
	const log = (text: string) => { job.log = (job.log + text).slice(-30000); };
	const locked = () => job.state === "running";

	async function reload() {
		review = undefined;
		reviewError = "";
		try { review = await createReviewData(directory, mappingPath); }
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

	await reload();
	return {
		async state() {
			return { directory, ownedFile: join(directory, ownedCarsFile), revision, reviewError,
				runs: await listRuns(), job: { ...job }, locked: locked() };
		},
		get directory() { return directory; },
		get review() { return requireReview(); },
		assertEditable(expected: unknown) {
			if (expected !== revision) throw new Error("This page is out of date. Reload the dashboard before making changes.");
			if (locked()) throw new Error("Wait for the running job to finish before editing or switching runs.");
		},
		async select(run: string) {
			await listRuns();
			if (!runs.has(run)) throw new Error("Select a saved run listed by the dashboard.");
			directory = runs.get(run)!;
			await reload();
		},
		async refresh() { await reload(); },
		changed() { revision++; },
		startJob(kind: string) {
			if (kind !== "match" && kind !== "ownership") throw new Error("Unknown workflow job.");
			job = { kind, state: "running", log: "", error: "" };
			const script = fileURLToPath(new URL(`../cli/${kind === "match" ? "match-ordinals" : "review-ownership"}.ts`, import.meta.url));
			const args = ["--use-system-ca", script, "--run-dir", directory];
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
		async dispose() {
			if (child) child.kill();
		},
	};
}
