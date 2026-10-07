import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SiteAdapter } from "../sites/types.ts";
import { createWorkflow } from "./workflow.ts";

export async function createReviewServer(directory: string, site: SiteAdapter, mappingPath?: string) {
	const workflow = await createWorkflow(directory, site, mappingPath);
	const token = randomBytes(32).toString("hex");
	let busy = false;
	const server = createServer(async (request, response) => {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
		const json = (value: unknown) => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); };
		try {
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("Server not listening.");
			const host = `127.0.0.1:${address.port}`;
			if (request.headers.host !== host) { response.writeHead(403).end("Invalid host."); return; }
			const url = new URL(request.url ?? "/", `http://${host}`);
			if (request.method === "GET" && url.pathname === "/api/state") { json(await workflow.state()); return; }
			if (request.method === "GET" && url.pathname === "/api/review") { json(workflow.review.snapshot()); return; }
			if (request.method === "GET" && url.pathname === "/api/plan") { json(await workflow.preview()); return; }
			if (request.method === "POST" && url.pathname.startsWith("/api/")) {
				const provided = request.headers["x-review-token"];
				if (request.headers.origin !== `http://${host}` || typeof provided !== "string" ||
					Buffer.byteLength(provided) !== Buffer.byteLength(token) || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) {
					response.writeHead(403).end("Invalid review session."); return;
				}
				if (busy) { response.writeHead(409).end("Another operation is in progress. Please retry."); return; }
				busy = true;
				try {
					let body = "";
					for await (const chunk of request) {
						body += chunk.toString();
						if (Buffer.byteLength(body) > 8192) throw new Error("Request too large.");
					}
					const input: unknown = JSON.parse(body);
					if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid request.");
					workflow.assertRevision("revision" in input ? input.revision : undefined);
					if (url.pathname === "/api/sync/close") {
						await workflow.closeSync();
					} else if (url.pathname === "/api/sync/confirm") {
						if (!("confirmation" in input) || typeof input.confirmation !== "string") throw new Error("Missing confirmation.");
						await workflow.confirmSync(input.confirmation, "destinationChecked" in input && input.destinationChecked === true);
					} else {
						workflow.assertEditable("revision" in input ? input.revision : undefined);
						switch (url.pathname) {
							case "/api/select":
								if (!("run" in input) || typeof input.run !== "string" || !("site" in input) || typeof input.site !== "string") throw new Error("Invalid run selection.");
								await workflow.select(input.run, input.site);
								break;
							case "/api/refresh": await workflow.refresh(); break;
							case "/api/job":
								if (!("kind" in input) || typeof input.kind !== "string") throw new Error("Missing job kind.");
								workflow.startJob(input.kind); break;
							case "/api/match":
								if (!("source" in input) || typeof input.source !== "string" || !("id" in input) ||
									(input.id !== null && typeof input.id !== "string")) throw new Error("Invalid match request.");
								try { await workflow.review.save(input.source, input.id); }
								finally { workflow.changed(); }
								break;
							case "/api/ownership":
								if (!("source" in input) || typeof input.source !== "string" || !("status" in input) ||
									(input.status !== null && input.status !== "owned" && input.status !== "unowned" && input.status !== "unknown")) throw new Error("Invalid ownership request.");
								if (input.status === "owned" && !("verified" in input && input.verified === true)) throw new Error("Verify the tile before marking it owned.");
								try { await workflow.review.saveOwnership(input.source, input.status); }
								finally { workflow.changed(); }
								break;
							case "/api/regenerate": await workflow.review.regenerate(); workflow.changed(); break;
							case "/api/sync/open":
								if (!("hash" in input) || typeof input.hash !== "string") throw new Error("Preview the plan first.");
								await workflow.openSync(input.hash); break;
							default: response.writeHead(404).end("Unknown operation."); return;
						}
					}
					json(await workflow.state());
				} finally { busy = false; }
				return;
			}
			if (request.method === "GET" && url.pathname === "/tile") {
				const source = url.searchParams.get("source");
				if (!source || !workflow.review.cars.some((car) => car.source === source)) { response.writeHead(404).end("Tile not found."); return; }
				response.setHeader("Content-Type", "image/png");
				response.end(await readFile(join(workflow.directory, ...source.split(/[\\/]/)))); return;
			}
			const assets: Record<string, { file: string; type: string }> = {
				"/": { file: "index.html", type: "text/html; charset=utf-8" },
				"/review.js": { file: "review.js", type: "text/javascript; charset=utf-8" },
				"/review.css": { file: "review.css", type: "text/css; charset=utf-8" },
			};
			const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
			if (request.method !== "GET" || !asset) { response.writeHead(404).end("Not found."); return; }
			let content = await readFile(new URL(asset.file, import.meta.url), "utf8");
			if (url.pathname === "/") content = content.replace("REVIEW_TOKEN", token);
			response.setHeader("Content-Type", asset.type); response.end(content);
		} catch (error) {
			console.error("[-] Dashboard request failed:", error);
			if (!response.headersSent) response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
			response.end(error instanceof Error ? error.message : "Dashboard request failed.");
		}
	});
	server.on("close", () => { void workflow.dispose().catch((error: unknown) => console.error("[-] Dashboard cleanup failed:", error)); });
	return server;
}
