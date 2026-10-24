import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { defaultGarageWalkKeys, isSameSelection, mergeCarPanels, walkGarage } from "../src/capture/garage-walk.ts";
import type { GarageCar } from "../src/capture/garage-walk.ts";
import type { CarPerformance } from "../src/ocr/car-performance.ts";

function observation(name: string, panel: CarPerformance["panel"], overrides: Partial<CarPerformance> = {}): CarPerformance {
	return {
		screen: "my-cars", panel,
		car: { name, year: 2020, manufacturer: "MAKER" },
		ratings: panel === "ratings"
			? { speed: 7, handling: 6, acceleration: 8, launch: 9, braking: 5, offroad: 4 }
			: { speed: null, handling: null, acceleration: null, launch: null, braking: null, offroad: null },
		details: panel === "details"
			? { power: { value: 500, unit: "hp" }, torque: { value: 400, unit: "ft-lb" }, weight: { value: 3000, unit: "lb" },
				front: { value: 50, unit: "%" }, displacement: { value: 4, unit: "l" } }
			: null,
		performance: { class: "A", pi: 800 },
		drivetrain: "RWD",
		tires: panel === "ratings" ? "Sport Tires" : null,
		evidence: {},
		issues: [],
		...overrides,
	};
}

/** A fake My Cars grid: `columns` wide, `count` cars, row-major. Screens are JSON of the visible state. */
function simulateGarage(count: number, columns: number, dropPresses: Set<number> = new Set()) {
	const state = { index: 0, panel: "ratings" as CarPerformance["panel"], presses: 0 };
	const pressed: string[] = [];
	const saved: string[] = [];
	const at = (row: number, column: number) => row * columns + column;
	return {
		pressed, saved,
		actions: {
			capture: async () => Buffer.from(JSON.stringify({ index: state.index, panel: state.panel })),
			press: async (key: string) => {
				pressed.push(key);
				if (dropPresses.has(++state.presses)) return;
				const row = Math.floor(state.index / columns);
				const column = state.index % columns;
				let next = state.index;
				if (key === "p") state.panel = state.panel === "ratings" ? "details" : "ratings";
				else if (key === "ArrowRight" && column + 1 < columns) next = at(row, column + 1);
				else if (key === "ArrowLeft" && column > 0) next = at(row, column - 1);
				else if (key === "ArrowDown") next = at(row + 1, column);
				if (next < count) state.index = next;
			},
			wait: async () => {},
			extract: async (image: Buffer) => {
				const screen = JSON.parse(image.toString()) as { index: number; panel: CarPerformance["panel"] };
				return observation(`CAR ${screen.index + 1}`, screen.panel);
			},
			isSameSelection: async (previous: Buffer, current: Buffer) =>
				JSON.parse(previous.toString()).index === JSON.parse(current.toString()).index,
			saveScreenshot: async (name: string) => { saved.push(name); },
			log: () => {},
		},
	};
}

describe("garage walk", () => {
	it("visits every car once in serpentine order, including a short last row", async () => {
		const garage = simulateGarage(11, 4);
		const streamed: GarageCar[] = [];
		const result = await walkGarage(garage.actions, { keys: defaultGarageWalkKeys, settleMs: 0, maxCars: 100 },
			async (car) => { streamed.push(car); });
		expect(result.status).toBe("completed");
		expect(result.cars.map((car) => car.car?.name)).toEqual(
			[1, 2, 3, 4, 8, 7, 6, 5, 9, 10, 11].map((number) => `CAR ${number}`));
		expect(streamed).toEqual(result.cars);
		for (const car of result.cars) {
			expect(car.issues).toEqual([]);
			expect(car.ratings?.speed).toBe(7);
			expect(car.details?.power).toEqual({ value: 500, unit: "hp" });
			expect(car.tires).toBe("Sport Tires");
		}
	});
	it("reaches a short last row that is offset from the end of the previous row", async () => {
		const garage = simulateGarage(9, 4);
		const result = await walkGarage(garage.actions, { keys: defaultGarageWalkKeys, settleMs: 0, maxCars: 100 }, async () => {});
		expect(result.cars.map((car) => car.car?.name)).toEqual([1, 2, 3, 4, 8, 7, 6, 5, 9].map((number) => `CAR ${number}`));
	});
	it("retries a dropped toggle and a dropped move", async () => {
		// Press 1 is the first toggle; press 4 is the first move after the retried toggle.
		const garage = simulateGarage(2, 2, new Set([1, 4]));
		const result = await walkGarage(garage.actions, { keys: defaultGarageWalkKeys, settleMs: 0, maxCars: 100 }, async () => {});
		expect(result.status).toBe("completed");
		expect(result.cars.map((car) => [car.car?.name, car.issues])).toEqual([["CAR 1", []], ["CAR 2", []]]);
		expect(result.cars[0]!.screenshots).toEqual({
			ratings: "car-0001-1.png", details: "car-0001-3.png", captures: ["car-0001-1.png", "car-0001-3.png"],
		});
		expect(garage.saved.slice(0, 3)).toEqual(["car-0001-1.png", "car-0001-2.png", "car-0001-3.png"]);
	});
	it("stops at the car limit", async () => {
		const garage = simulateGarage(20, 5);
		const result = await walkGarage(garage.actions, { keys: defaultGarageWalkKeys, settleMs: 0, maxCars: 3 }, async () => {});
		expect(result.status).toBe("limit");
		expect(result.cars).toHaveLength(3);
	});
	it("keeps cars already walked when navigation fails", async () => {
		const garage = simulateGarage(5, 5);
		let compares = 0;
		const result = await walkGarage({
			...garage.actions,
			isSameSelection: async (previous, current) => {
				if (++compares === 2) throw new Error("Cannot locate the highlighted My Cars tile.");
				return garage.actions.isSameSelection(previous, current);
			},
		}, { keys: defaultGarageWalkKeys, settleMs: 0, maxCars: 100 }, async () => {});
		expect(result.status).toBe("interrupted");
		expect(result.error).toContain("highlighted");
		expect(result.cars).toHaveLength(2);
	});
});

describe("panel merge", () => {
	it("reports disagreements and missing panels instead of choosing a value", () => {
		const car = mergeCarPanels(1, [
			{ screenshot: "a.png", observation: observation("ONE", "ratings") },
			{ screenshot: "b.png", observation: observation("ONE", "details", { performance: { class: "S1", pi: 801 } }) },
		]);
		expect(car.performance).toBeNull();
		expect(car.issues).toEqual([expect.stringContaining("disagree on class/PI")]);
		const partial = mergeCarPanels(2, [
			{ screenshot: "a.png", observation: observation("TWO", "ratings", { issues: ["Could not read class and PI."], performance: null }) },
			{ screenshot: "b.png", observation: null, error: "Expected My Cars screen" },
		]);
		expect(partial.performance).toBeNull();
		expect(partial.car?.name).toBe("TWO");
		expect(partial.details).toBeNull();
		expect(partial.issues).toEqual([
			"b.png: Expected My Cars screen", "Details panel was not captured.", "ratings: Could not read class and PI.",
		]);
	});
});

describe("selection comparison", () => {
	async function screen(tileLeft: number, label: string): Promise<Buffer> {
		return sharp(Buffer.from(
			'<svg width="1365" height="768"><rect width="100%" height="100%" fill="black"/>' +
			`<rect x="${tileLeft}" y="150" width="230" height="175" fill="white" stroke="#caff00" stroke-width="3"/>` +
			`<text x="${tileLeft + 115}" y="180" font-family="Arial" font-size="20" text-anchor="middle">${label}</text></svg>`,
		)).png().toBuffer();
	}
	it("detects a moved highlight and a scrolled tile but not compression noise", async () => {
		const base = await screen(535, "SPEEDTAIL");
		const noisy = await sharp(base).jpeg({ quality: 40 }).toBuffer();
		expect(await isSameSelection(base, await sharp(noisy).png().toBuffer())).toBe(true);
		expect(await isSameSelection(base, await screen(780, "SPEEDTAIL"))).toBe(false);
		expect(await isSameSelection(base, await screen(535, "CHIRON"))).toBe(false);
	});
});
