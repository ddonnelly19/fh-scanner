import { kudosPrimeAdapter } from "./kudosprime/adapter.ts";
import { forzaGarageAdapter } from "./forzagarage/adapter.ts";
import type { SiteAdapter } from "./types.ts";

export const siteAdapters: readonly SiteAdapter[] = [kudosPrimeAdapter, forzaGarageAdapter];

export function getSiteAdapter(id: string): SiteAdapter {
	const adapter = siteAdapters.find((site) => site.id === id);
	if (!adapter) {
		throw new Error(`Unsupported site "${id}". Available sites: ${siteAdapters.map((site) => site.id).join(", ")}.`);
	}
	return adapter;
}
