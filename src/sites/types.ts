import type { Page } from "playwright";
import type { CatalogSource } from "../catalogs/types.ts";

export interface GarageCar {
	id: string;
	name: string;
	sources: string[];
}

export interface GaragePlanTarget {
	id: string;
	label: string;
	acceptsLegacyPlan: boolean;
	isValidCarId(id: string): boolean;
}

export interface SiteAdapter extends GaragePlanTarget {
	catalog: CatalogSource;
	planFile: string;
	resultPrefix: string;
	loginUrl: string;
	requestDelayMs: number;
	sessionInstructions?: string;
	assertReady(pageUrl: string): void;
	addOwned(page: Page, carId: string): Promise<void>;
	loadOwnedIds?(page: Page, carIds: readonly string[]): Promise<Set<string>>;
	shareCollectionUrl?(page: Page): Promise<string>;
}
