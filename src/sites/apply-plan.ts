import type { GarageCar } from "./types.ts";

export interface SyncResult {
	id: string;
	name: string;
	status: "confirmed" | "uncertain";
}

export interface ApplyOperations {
	addOwned(car: GarageCar): Promise<void>;
	persist(results: readonly SyncResult[]): Promise<void>;
	onConfirmed(car: GarageCar): void;
	wait(milliseconds: number): Promise<void>;
}

export async function applyGaragePlan(
	cars: readonly GarageCar[],
	delayMs: number,
	operations: ApplyOperations,
): Promise<SyncResult[]> {
	const results: SyncResult[] = [];
	for (const car of cars) {
		const result: SyncResult = { id: car.id, name: car.name, status: "uncertain" };
		results.push(result);
		await operations.persist(results);
		await operations.addOwned(car);
		result.status = "confirmed";
		await operations.persist(results);
		operations.onConfirmed(car);
		await operations.wait(delayMs);
	}
	return results;
}
