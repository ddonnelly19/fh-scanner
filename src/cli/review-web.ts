import { parseArgs } from "node:util";
import { resolveRunDirectory } from "../workflows/run-directory.ts";
import { createReviewServer } from "../web/review-server.ts";

async function main() {
	const { values } = parseArgs({ options: {
		"run-dir": { type: "string" },
		port: { type: "string", default: "4173" },
	} });
	if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) throw new Error("--port must be between 0 and 65535.");
	const directory = await resolveRunDirectory(values["run-dir"]);
	const server = await createReviewServer(directory);
	server.on("error", (error) => { console.error("[-] Web review server failed:", error); process.exitCode = 1; });
	server.listen(Number(values.port), "127.0.0.1", () => {
		const address = server.address();
		if (address && typeof address !== "string") console.log(`[+] Dashboard: http://127.0.0.1:${address.port}\n[+] Run: ${directory}\n[+] Local saved-run jobs and review; writes owned-cars.json for forzagarage's collection-sync. Press Ctrl+C to stop.`);
	});
	process.once("SIGINT", () => server.close());
}

main().catch((error: unknown) => { console.error("[-] Cannot start web review:", error); process.exitCode = 1; });
