export interface CatalogEntry {
	name: string;
	ordinal?: string;
	siteIds?: Record<string, string>;
}

export interface CatalogSnapshot {
	entries: CatalogEntry[];
	content: string;
}

export interface CatalogSource {
	id: string;
	snapshotFile: string;
	load(path?: string): Promise<CatalogSnapshot>;
}
