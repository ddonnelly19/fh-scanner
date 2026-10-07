import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadOrdinalCatalog } from "../catalogs/hdr.ts";
import { siteAdapters } from "../sites/registry.ts";
import type { SiteAdapter } from "../sites/types.ts";
import { mergeCatalogEntries } from "./export-cars.ts";

export async function loadOwnershipCatalogs(directory: string, target: SiteAdapter) {
	const files = new Set(await readdir(directory));
	if (!files.has(target.catalog.snapshotFile)) {
		throw new Error(`Missing ${target.label} catalog snapshot "${target.catalog.snapshotFile}". Refresh this run's catalogs first: node --use-system-ca .\\src\\cli\\match-ordinals.ts --run-dir "${directory}"`);
	}
	const sites = siteAdapters.filter((site) => files.has(site.catalog.snapshotFile));
	const snapshots = await Promise.all([
		loadOrdinalCatalog(join(directory, "car-ordinals-source.json")),
		...sites.map((site) => site.catalog.load(join(directory, site.catalog.snapshotFile))),
	]);
	return mergeCatalogEntries(snapshots.map((snapshot) => snapshot.entries));
}
