import { describe, expect, it } from "vitest";
import { pageGarage } from "../src/capture/garage-pages.ts";
import type { CardLayout, CardReading } from "../src/ocr/my-cars-cards.ts";

/**
 * A fake My Cars grid with the given column heights and four fully visible columns. Right moves the highlight one
 * column and scrolls it to the left edge until the last columns are on screen; after that the highlight moves
 * across the screen. Screens are JSON of the visible state.
 */
function simulateGrid(heights: number[], dropPresses: Set<number> = new Set(), visible = 4) {
	const state = { selected: 0, presses: 0 };
	const pressed: string[] = [];
	const files = new Map<string, Buffer>();
	const first = () => Math.min(state.selected, Math.max(0, heights.length - visible));
	const parse = (image: Buffer) => JSON.parse(image.toString()) as { first: number; selected: number };
	const reading = (column: number, row: number, overrides: Partial<CardReading> = {}): CardReading => ({
		column, row, selected: false, car: { name: `CAR ${column}-${row}`, year: 2020, manufacturer: "MAKER" }, nameComplete: true,
		rarity: "EPIC", performance: { class: "A", pi: 700 }, drivetrain: "AWD", tires: "Rally Tires", evidence: {}, issues: [], ...overrides,
	});
	return {
		pressed, files, reading,
		actions: {
			capture: async () => Buffer.from(JSON.stringify({ first: first(), selected: state.selected })),
			press: async (key: string) => {
				pressed.push(key);
				if (dropPresses.has(++state.presses)) return;
				if (key === "ArrowRight") state.selected = Math.min(state.selected + 1, heights.length - 1);
			},
			wait: async () => {},
			layout: async (image: Buffer): Promise<CardLayout> => {
				const screen = parse(image);
				const columns = Math.min(visible, heights.length - screen.first);
				const cards = [];
				for (let column = 0; column < columns; column++) {
					for (let row = 0; row < heights[screen.first + column]!; row++) {
						cards.push({ column, row, selected: screen.first + column === screen.selected && row === 0,
							bounds: { left: column, top: row, width: 1, height: 1 } });
					}
				}
				return { columns, cards, selectedColumn: screen.selected - screen.first };
			},
			isSameScreen: async (previous: Buffer, current: Buffer) => previous.equals(current),
			read: async (image: Buffer) => {
				const screen = parse(image);
				const readings: CardReading[] = [];
				for (let column = 0; column < Math.min(visible, heights.length - screen.first); column++) {
					for (let row = 0; row < heights[screen.first + column]!; row++) {
						readings.push({ ...reading(screen.first + column, row), column });
					}
				}
				return readings;
			},
			saveScreenshot: async (name: string, image: Buffer) => { files.set(name, image); },
			loadScreenshot: async (name: string) => files.get(name)!,
			log: () => {},
		},
	};
}

const options = { right: "ArrowRight", settleMs: 0, maxPages: 100 };
const positions = (cars: Array<{ column: number; row: number }>) => cars.map((car) => `${car.column}-${car.row}`);
const expected = (heights: number[]) => heights.flatMap((height, column) => Array.from({ length: height }, (_, row) => `${column}-${row}`));

describe("garage paging", () => {
	it("captures one page per four columns and reads every card once", async () => {
		const heights = [1, 3, 2, 3, 1, 2, 3, 3, 1, 2, 2];
		const grid = simulateGrid(heights);
		const result = await pageGarage(grid.actions, options, async () => {});
		expect(result.status).toBe("completed");
		expect(positions(result.cars)).toEqual(expected(heights));
		expect(result.cars.map((car) => car.car?.name)).toEqual(expected(heights).map((position) => `CAR ${position}`));
		// Pages start at columns 0 and 4; the grid then stops scrolling, so the last page shows columns 7-10.
		expect(result.pages.map((page) => [page.screenshot, page.firstColumn])).toEqual([
			["page-001.png", 0], ["page-002.png", 4], ["page-003.png", 7],
		]);
		expect(result.cars.every((car) => car.issues.length === 0)).toBe(true);
	});
	it("ends on a single page when every column fits", async () => {
		const grid = simulateGrid([2, 1, 3]);
		const result = await pageGarage(grid.actions, options, async () => {});
		expect(result.status).toBe("completed");
		expect(result.pages).toHaveLength(1);
		expect(positions(result.cars)).toEqual(expected([2, 1, 3]));
		// Two moves across the page, then two presses that change nothing.
		expect(grid.pressed).toHaveLength(4);
	});
	it("retries a dropped Right instead of stopping early", async () => {
		const heights = [1, 1, 1, 1, 1, 1, 1, 1, 1];
		const grid = simulateGrid(heights, new Set([2, 6]));
		const result = await pageGarage(grid.actions, options, async () => {});
		expect(result.status).toBe("completed");
		expect(positions(result.cars)).toEqual(expected(heights));
	});
	it("reports a card read differently on overlapping pages instead of picking one", async () => {
		const heights = [1, 1, 1, 1, 1, 1];
		const grid = simulateGrid(heights);
		let reads = 0;
		const result = await pageGarage({
			...grid.actions,
			read: async (image) => {
				const readings = await grid.actions.read(image);
				return ++reads === 2 ? readings.map((reading) => reading.car?.name === "CAR 3-0"
					? { ...reading, performance: { class: "A", pi: 799 } } : reading) : readings;
			},
		}, options, async () => {});
		const car = result.cars.find((card) => card.column === 3)!;
		expect(car.performance).toEqual({ class: "A", pi: 700 });
		expect(car.issues).toEqual([expect.stringContaining("read this card differently")]);
	});
	it("keeps paging while OCR is still reading earlier pages", async () => {
		const heights = Array(12).fill(2) as number[];
		const grid = simulateGrid(heights);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const paging = pageGarage({
			...grid.actions,
			read: async (image) => {
				await gate;
				return grid.actions.read(image);
			},
		}, options, async () => {});
		for (let tick = 0; tick < 200; tick++) await Promise.resolve();
		const pressedWhileBlocked = grid.pressed.length;
		release();
		const result = await paging;
		expect(pressedWhileBlocked).toBe(grid.pressed.length);
		expect(positions(result.cars)).toEqual(expected(heights));
	});
	it("stops at the page limit and requires a top-row start", async () => {
		const grid = simulateGrid(Array(12).fill(1) as number[]);
		const limited = await pageGarage(grid.actions, { ...options, maxPages: 1 }, async () => {});
		expect(limited.status).toBe("limit");
		expect(limited.cars).toHaveLength(4);
		const lower = simulateGrid([2, 2]);
		const result = await pageGarage({
			...lower.actions,
			layout: async (image) => {
				const layout = await lower.actions.layout(image);
				return { ...layout, cards: layout.cards.map((card) => ({ ...card, selected: card.row === 1 && card.column === 0 })) };
			},
		}, options, async () => {});
		expect(result.status).toBe("interrupted");
		expect(result.error).toContain("top row");
	});
	it("records a page whose read failed and carries on", async () => {
		const grid = simulateGrid(Array(8).fill(1) as number[]);
		let reads = 0;
		const result = await pageGarage({
			...grid.actions,
			read: async (image) => {
				if (++reads === 1) throw new Error("Cannot locate cards");
				return grid.actions.read(image);
			},
		}, options, async () => {});
		expect(result.status).toBe("completed");
		expect(result.pages[0]!.error).toBe("Cannot locate cards");
		expect(positions(result.cars)).toEqual(["4-0", "5-0", "6-0", "7-0"]);
	});
});
