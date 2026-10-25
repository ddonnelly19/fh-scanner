import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { defaultGarageWalkKeys, hasTileBelow, isDirectlyBelow, isSameSelection, mergeCarPanels, walkGarage } from "../src/capture/garage-walk.ts";
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

/**
 * A fake My Cars grid of manufacturer columns with the given heights. Right keeps the row when the next column
 * is tall enough and otherwise lands on its last car. Down at the bottom of a column jumps diagonally into a taller
 * neighbouring column, as the game does. Screens are JSON of the visible state.
 */
function simulateGarage(heights: number[], dropPresses: Set<number> = new Set()) {
	const state = { column: 0, row: 0, panel: "ratings" as CarPerformance["panel"], presses: 0 };
	const pressed: string[] = [];
	const saved: string[] = [];
	const number = (column: number, row: number) => heights.slice(0, column).reduce((sum, height) => sum + height, 0) + row + 1;
	const screen = () => Buffer.from(JSON.stringify({
		car: number(state.column, state.row), column: state.column, row: state.row, panel: state.panel,
	}));
	const parse = (image: Buffer) => JSON.parse(image.toString()) as { car: number; column: number; row: number };
	return {
		pressed, saved,
		actions: {
			capture: async () => screen(),
			press: async (key: string) => {
				pressed.push(key);
				if (dropPresses.has(++state.presses)) return;
				if (key === "l") state.panel = state.panel === "ratings" ? "details" : "ratings";
				else if (key === "ArrowDown" && state.row + 1 < heights[state.column]!) state.row++;
				else if (key === "ArrowDown") {
					const neighbour = [state.column + 1, state.column - 1].find((column) => (heights[column] ?? 0) > state.row + 1);
					if (neighbour !== undefined) {
						state.column = neighbour;
						state.row++;
					}
				}
				else if (key === "ArrowUp" && state.row > 0) state.row--;
				else if (key === "ArrowRight" && state.column + 1 < heights.length) {
					state.column++;
					state.row = Math.min(state.row, heights[state.column]! - 1);
				}
			},
			wait: async () => {},
			extract: async (image: Buffer) => {
				const visible = JSON.parse(image.toString()) as { car: number; panel: CarPerformance["panel"] };
				return observation(`CAR ${visible.car}`, visible.panel);
			},
			isSameSelection: async (previous: Buffer, current: Buffer) => parse(previous).car === parse(current).car,
			isDirectlyBelow: async (previous: Buffer, current: Buffer) =>
				parse(previous).column === parse(current).column && parse(current).row === parse(previous).row + 1,
			hasTileBelow: async (image: Buffer) => parse(image).row + 1 < heights[parse(image).column]!,
			selectionTop: async (image: Buffer) => 0.2 + 0.23 * parse(image).row,
			saveScreenshot: async (name: string) => { saved.push(name); },
			log: () => {},
		},
	};
}

const walkOptions = { keys: defaultGarageWalkKeys, settleMs: 0, maxCars: 100 };
const names = (cars: GarageCar[]) => cars.map((car) => car.car?.name);
const numbered = (count: number) => Array.from({ length: count }, (_, index) => `CAR ${index + 1}`);

describe("garage walk", () => {
	it("visits every car once, column by column", async () => {
		const garage = simulateGarage([1, 3, 1, 3, 2]);
		const streamed: GarageCar[] = [];
		const result = await walkGarage(garage.actions, walkOptions, async (car) => { streamed.push(car); });
		expect(result.status).toBe("completed");
		expect(names(result.cars)).toEqual(numbered(10));
		expect(streamed).toEqual(result.cars);
		for (const car of result.cars) {
			expect(car.issues).toEqual([]);
			expect(car.ratings?.speed).toBe(7);
			expect(car.details?.power).toEqual({ value: 500, unit: "hp" });
			expect(car.tires).toBe("Sport Tires");
		}
	});
	it("never presses Down at the bottom of a column, where the game jumps into a neighbouring column", async () => {
		// Seen live: Down from the lone Current Car tile and from the bottom of a 2-car column both left the column.
		const garage = simulateGarage([1, 3, 2, 1, 3]);
		const result = await walkGarage(garage.actions, walkOptions, async () => {});
		expect(result.status).toBe("completed");
		expect(names(result.cars)).toEqual(numbered(10));
		expect(garage.pressed.filter((key) => key === "ArrowDown")).toHaveLength(5);
	});
	it("stops instead of revisiting cars when Down leaves the column", async () => {
		const garage = simulateGarage([1, 3]);
		const result = await walkGarage({ ...garage.actions, hasTileBelow: async () => true }, walkOptions, async () => {});
		expect(result.status).toBe("interrupted");
		expect(result.error).toContain("left the column");
		expect(names(result.cars)).toEqual(["CAR 1"]);
	});
	it("climbs to the top of a column that Right enters on a lower row", async () => {
		const garage = simulateGarage([3, 3]);
		const result = await walkGarage(garage.actions, walkOptions, async () => {});
		expect(names(result.cars)).toEqual(numbered(6));
		expect(garage.pressed.filter((key) => key === "ArrowUp")).toHaveLength(2);
	});
	it("retries a dropped toggle and a dropped move", async () => {
		// Press 1 is the first toggle; presses 3-4 find the column end; press 5 is the first Right.
		const garage = simulateGarage([1, 1], new Set([1, 5]));
		const result = await walkGarage(garage.actions, walkOptions, async () => {});
		expect(result.status).toBe("completed");
		expect(result.cars.map((car) => [car.car?.name, car.issues])).toEqual([["CAR 1", []], ["CAR 2", []]]);
		expect(result.cars[0]!.screenshots).toEqual({
			ratings: "car-0001-1.png", details: "car-0001-3.png", captures: ["car-0001-1.png", "car-0001-3.png"],
		});
		expect(garage.saved.slice(0, 3)).toEqual(["car-0001-1.png", "car-0001-2.png", "car-0001-3.png"]);
	});
	it("stops at the car limit", async () => {
		const garage = simulateGarage([3, 3, 3]);
		const result = await walkGarage(garage.actions, { ...walkOptions, maxCars: 3 }, async () => {});
		expect(result.status).toBe("limit");
		expect(result.cars).toHaveLength(3);
	});
	it("keeps cars already walked when navigation fails", async () => {
		const garage = simulateGarage([5]);
		let compares = 0;
		const result = await walkGarage({
			...garage.actions,
			isSameSelection: async (previous, current) => {
				if (++compares === 2) throw new Error("Cannot locate the highlighted My Cars tile.");
				return garage.actions.isSameSelection(previous, current);
			},
		}, walkOptions, async () => {});
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
	it("keeps the more confident identity when the panels differ by an OCR typo, and still reports it", () => {
		const typo = (manufacturer: string, confidence: number) => ({
			car: { name: "8C COMPETIZIONE", year: 2007, manufacturer },
			evidence: { car: { text: "", confidence } },
		});
		const car = mergeCarPanels(1, [
			{ screenshot: "a.png", observation: observation("8C COMPETIZIONE", "details", typo("ALFA ROMEQ", 90)) },
			{ screenshot: "b.png", observation: observation("8C COMPETIZIONE", "ratings", typo("ALFA ROMEO", 93)) },
		]);
		expect(car.car).toEqual({ name: "8C COMPETIZIONE", year: 2007, manufacturer: "ALFA ROMEO" });
		expect(car.issues).toEqual([expect.stringContaining("disagree on car"), expect.stringContaining("more confident")]);
		const different = mergeCarPanels(2, [
			{ screenshot: "a.png", observation: observation("SPEEDTAIL", "ratings") },
			{ screenshot: "b.png", observation: observation("SENNA", "details") },
		]);
		expect(different.car).toBeNull();
		expect(different.issues).toEqual([expect.stringContaining("disagree on car")]);
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
	it("tells a move down the column from a jump into the column on the left", async () => {
		const grid = (tiles: Array<[number, number, string]>, selected: [number, number]) => sharp(Buffer.from(
			'<svg width="1365" height="768"><rect width="100%" height="100%" fill="black"/>' +
			tiles.map(([x, y, label]) => `<rect x="${x}" y="${y}" width="230" height="150" fill="white"` +
				(x === selected[0] && y === selected[1] ? ' stroke="#caff00" stroke-width="3"' : "") + "/>" +
				`<text x="${x + 115}" y="${y + 60}" font-family="Arial" font-size="20" text-anchor="middle">${label}</text>`).join("") +
			"</svg>",
		)).png().toBuffer();
		const before = await grid([[300, 145, "AUTODELTA"], [300, 305, "GIULIA SPRINT"], [540, 145, "TRICK TRUCK"]], [300, 305]);
		const down = await grid([[300, 145, "AUTODELTA"], [300, 305, "GIULIA SPRINT"], [300, 465, "NEW CAR"]], [300, 465]);
		const jumped = await grid([[300, 145, "8C"], [300, 305, "155 Q4"], [300, 465, "SE 048SP"]], [300, 465]);
		expect(await isDirectlyBelow(before, down)).toBe(true);
		expect(await isDirectlyBelow(before, jumped)).toBe(false);
		expect(await hasTileBelow(await grid([[300, 145, "AUTODELTA"], [300, 305, "GIULIA SPRINT"]], [300, 145]))).toBe(true);
		expect(await hasTileBelow(before)).toBe(false);
		expect(await hasTileBelow(down)).toBe(false);
		expect(await hasTileBelow(await grid([[300, 145, "CURRENT"], [540, 145, "124 SPIDER"], [540, 305, "695"]], [300, 145]))).toBe(false);
	});
});
