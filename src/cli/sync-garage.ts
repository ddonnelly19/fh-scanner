import { parseArgs } from "node:util";
import { parseGaragePlan } from "../sites/garage-plan.ts";
import { getSiteAdapter } from "../sites/registry.ts";
import { syncWithBrowser } from "../sites/browser-sync.ts";
import { readSyncPlan } from "../workflows/sync-input.ts";
import { resolveRunDirectory } from "../workflows/run-directory.ts";

async function main(): Promise<void> {
	const { values } = parseArgs({ options: {
		"run-dir": { type: "string" },
		apply: { type: "boolean", default: false },
		site: { type: "string", default: "kudosprime" },
	} });
	const site = getSiteAdapter(values.site);
	const directory = await resolveRunDirectory(values["run-dir"]);
	console.log(`[+] Selected run: ${directory}`);
	const plan = await readSyncPlan(directory, site.planFile, site.id);
	const cars = parseGaragePlan(plan, site);
	for (const car of cars) console.log(`${car.id}\t${car.name}`);
	console.log(`[+] ${cars.length} unique cars in reviewed ${site.label} owned plan. Unowned/unknown cars are not included.`);
	if (!values.apply) {
		console.log("[+] Preview only. No browser login or account updates. Add --apply to continue with browser login and confirmation.");
		return;
	}
	try {
		await syncWithBrowser(site, cars, directory);
	} catch (error) {
		console.error("Check any sync result file and account before retrying; uncertain requests may have reached the server.");
		throw error;
	}
}

main().catch((error: unknown) => {
	console.error("[-] Garage sync stopped:", error);
	process.exitCode = 1;
});
