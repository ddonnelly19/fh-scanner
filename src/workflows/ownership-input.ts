import { access } from "node:fs/promises";
import { join } from "node:path";
import { hdrCatalog, loadOrdinalCatalog } from "../catalogs/hdr.ts";

/** The run's saved name→ordinal snapshot, so ownership uses exactly what matching used. */
export async function loadOwnershipCatalog(directory: string) {
	const path = join(directory, hdrCatalog.snapshotFile);
	try {
		await access(path);
	} catch {
		throw new Error(`Missing "${hdrCatalog.snapshotFile}" in this run. Match names first: node --use-system-ca .\src\cli\match-ordinals.ts --run-dir "${directory}"`);
	}
	return (await loadOrdinalCatalog(path)).entries;
}
