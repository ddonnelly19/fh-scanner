import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
	buildIconTemplates, cardPixels, findCards, iconBoxes, iconSearchArea, loadIconTemplates, matchIcon, rarityFromColour, readCard,
} from "../src/ocr/my-cars-cards.ts";
import type { IconTemplate } from "../src/ocr/my-cars-cards.ts";
import { createLocalOCRWorker } from "../src/ocr/ocr.ts";

// A 1920x1080 My Cars page: cards are 323x243 at the measured fractions of the screen.
const columnLefts = [408, 740, 1085, 1430];
const rowTops = [212, 464, 716];

interface SvgCard { name: string; year: string; maker: string; rarity: string; colour: string; badge: string; pi: string; drive: string; tire: string }

/** Drivetrain icons are axles on a car outline; tire icons are rings. Shapes are drawn at card coordinates (323 wide). */
const drivetrainSvg: Record<string, string> = {
	AWD: '<rect x="16" y="178" width="6" height="22"/><rect x="50" y="178" width="6" height="22"/><rect x="18" y="187" width="36" height="4"/>',
	RWD: '<rect x="16" y="178" width="6" height="22"/><rect x="12" y="185" width="16" height="8"/>',
	FWD: '<rect x="50" y="178" width="6" height="22"/><rect x="44" y="185" width="16" height="8"/>',
	unknown: '<circle cx="36" cy="189" r="11"/>',
};
const tireSvg: Record<string, string> = {
	Street: '<circle cx="88" cy="189" r="11" fill="none" stroke="black" stroke-width="3"/><path d="M88 178 V200 M77 189 H99" stroke="black" stroke-width="3"/>',
	Slick: '<circle cx="88" cy="189" r="9" fill="none" stroke="black" stroke-width="6"/>',
	unknown: '<rect x="78" y="179" width="20" height="20"/>',
};

function cardSvg(left: number, top: number, card: SvgCard, selected: boolean): string {
	const centre = left + 161;
	return `<g>${selected ? `<rect x="${left - 5}" y="${top - 7}" width="333" height="257" fill="none" stroke="#caff00" stroke-width="4"/>` : ""}` +
		`<rect x="${left}" y="${top}" width="323" height="243" fill="white"/>` +
		`<g font-family="Arial" text-anchor="middle"><text x="${centre}" y="${top + 30}" font-size="26" font-weight="bold">${card.name}</text>` +
		`<text x="${centre}" y="${top + 55}" font-size="21" fill="#777">${card.year} ${card.maker}</text></g>` +
		`<g transform="translate(${left} ${top})">${drivetrainSvg[card.drive]}${tireSvg[card.tire]}</g>` +
		`<rect x="${left + 3}" y="${top + 206}" width="222" height="29" fill="${card.colour}"/>` +
		`<text x="${left + 12}" y="${top + 229}" font-family="Arial" font-size="20" font-weight="bold" fill="white">${card.rarity}</text>` +
		`<rect x="${left + 229}" y="${top + 206}" width="33" height="29" fill="#e8173f"/>` +
		`<text x="${left + 236}" y="${top + 229}" font-family="Arial" font-size="21" font-weight="bold" fill="white">${card.badge}</text>` +
		`<rect x="${left + 263}" y="${top + 206}" width="47" height="29" fill="black"/>` +
		`<text x="${left + 270}" y="${top + 229}" font-family="Arial" font-size="21" fill="white">${card.pi}</text></g>`;
}

const sample: SvgCard = { name: "SPEEDTAIL", year: "2019", maker: "MCLAREN", rarity: "EPIC", colour: "#d24be6", badge: "A", pi: "700", drive: "AWD", tire: "Street" };

async function page(cards: Array<[number, number, SvgCard]>): Promise<Buffer> {
	const body = cards.map(([column, row, card]) => cardSvg(columnLefts[column]!, rowTops[row]!, card, column === 0 && row === 0)).join("");
	// A dimmed column cut off by the right edge, as the game shows the next page's first column.
	const partial = `<rect x="1775" y="212" width="145" height="243" fill="#6a6a6a"/>`;
	return sharp(Buffer.from(`<svg width="1920" height="1080"><rect width="100%" height="100%" fill="#2b2b2b"/>${body}${partial}</svg>`)).png().toBuffer();
}

async function templatesFrom(image: Buffer, labels: Array<[number, "drivetrain" | "tires", string]>): Promise<IconTemplate[]> {
	const { cards } = await findCards(image);
	const samples: IconTemplate[] = [];
	for (const [index, kind, label] of labels) {
		const box = iconBoxes[kind];
		samples.push({ kind, label, width: box.width, height: box.height, pixels: await cardPixels(image, cards[index]!.bounds, box) });
	}
	return buildIconTemplates(samples);
}

describe("My Cars card layout", () => {
	it("finds fully visible cards by column, skipping empty slots and the cut-off column", async () => {
		const image = await page([[0, 0, sample], [0, 1, sample], [1, 0, sample], [2, 0, sample], [2, 2, sample], [3, 0, sample]]);
		const layout = await findCards(image);
		expect(layout.columns).toBe(4);
		expect(layout.selectedColumn).toBe(0);
		expect(layout.cards.map((card) => [card.column, card.row, card.selected])).toEqual([
			[0, 0, true], [0, 1, false], [1, 0, false], [2, 0, false], [2, 2, false], [3, 0, false],
		]);
		for (const card of layout.cards) {
			expect(Math.abs(card.bounds.left - columnLefts[card.column]!)).toBeLessThanOrEqual(2);
			expect(Math.abs(card.bounds.width - 323)).toBeLessThanOrEqual(3);
		}
	});
	it("rejects screenshots that aren't 16:9", async () => {
		const image = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "black" } }).png().toBuffer();
		await expect(findCards(image)).rejects.toThrow("16:9");
	});
});

describe("card icon matching", () => {
	function ring(width: number, height: number, cx: number, cy: number, inner: number, outer: number, noise = 0): Uint8Array {
		const pixels = new Uint8Array(width * height);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const distance = Math.hypot(x - cx, y - cy);
				const value = distance >= inner && distance <= outer ? 20 : 235;
				pixels[y * width + x] = Math.max(0, Math.min(255, value + Math.round(Math.sin(x * 7 + y * 13) * noise)));
			}
		}
		return pixels;
	}
	const template = (label: string, inner: number, outer: number): IconTemplate =>
		({ kind: "tires", label, width: 40, height: 40, pixels: ring(40, 40, 20, 20, inner, outer) });
	const templates = [template("Slick Tires", 8, 16), template("Thin Tires", 14, 16)];

	it("matches a shifted, noisy icon to its template", () => {
		const area = ring(60, 60, 27, 33, 8, 16, 12);
		expect(matchIcon(area, 60, 60, templates).label).toBe("Slick Tires");
	});
	it("leaves an icon unlike every template unknown", () => {
		const match = matchIcon(ring(60, 60, 30, 30, 0, 4), 60, 60, templates);
		expect(match.label).toBeNull();
		expect(match.score).toBeLessThan(0.97);
	});
	it("leaves an icon unknown when two labels match equally well", () => {
		const twins = [template("A", 8, 16), template("B", 8, 16)];
		expect(matchIcon(ring(60, 60, 30, 30, 8, 16), 60, 60, twins).label).toBeNull();
	});
	it("averages similar samples and keeps a dissimilar one as another variant", () => {
		const built = buildIconTemplates([template("Slick Tires", 8, 16), template("Slick Tires", 8, 16), template("Slick Tires", 2, 5)]);
		expect(built.map((item) => item.label)).toEqual(["Slick Tires", "Slick Tires"]);
	});
	it("ships templates for the icons seen so far", async () => {
		const shipped = await loadIconTemplates();
		expect(new Set(shipped.map((item) => `${item.kind}:${item.label}`))).toEqual(new Set([
			"drivetrain:AWD", "drivetrain:FWD", "drivetrain:RWD",
			"tires:Street Tires", "tires:Rally Tires", "tires:Horizon Semi-Slick Tires", "tires:Slick Tires",
		]));
		for (const item of shipped) {
			expect([item.width, item.height]).toEqual([iconBoxes[item.kind].width, iconBoxes[item.kind].height]);
		}
		expect(iconSearchArea("tires").width).toBeGreaterThan(iconBoxes.tires.width);
	});
	it("names rarities by bar colour", () => {
		expect(rarityFromColour(49, 173, 36)).toBe("COMMON");
		expect(rarityFromColour(18, 170, 214)).toBe("RARE");
		expect(rarityFromColour(210, 75, 230)).toBe("EPIC");
		expect(rarityFromColour(240, 140, 20)).toBe("LEGENDARY");
		expect(rarityFromColour(120, 120, 120)).toBeNull();
	});
});

describe("card reading", () => {
	it("reads identity, rarity, class/PI and icons, flagging cut-off names and unknown icons", async () => {
		const reference = await page([
			[0, 0, sample],
			[1, 0, { ...sample, drive: "RWD", tire: "Slick" }],
			[2, 0, { ...sample, drive: "FWD", tire: "Slick" }],
		]);
		const templates = await templatesFrom(reference, [
			[0, "drivetrain", "AWD"], [0, "tires", "Street Tires"], [1, "drivetrain", "RWD"], [1, "tires", "Slick Tires"], [2, "drivetrain", "FWD"],
		]);
		const image = await page([
			[0, 0, sample],
			[1, 0, { name: "AUTODELTA TIPO 33/2 D...", year: "1968", maker: "ALFA ROMEO", rarity: "LEGENDARY", colour: "#ef8a12",
				badge: "R", pi: "998", drive: "FWD", tire: "Slick" }],
			[2, 0, { ...sample, rarity: "COMMON", colour: "#31ad24", drive: "unknown", tire: "unknown" }],
		]);
		const { cards } = await findCards(image);
		const [worker, shapeWorker] = await Promise.all([createLocalOCRWorker(), createLocalOCRWorker("legacy")]);
		try {
			const first = await readCard(image, cards[0]!, worker, shapeWorker, templates);
			expect(first).toMatchObject({
				column: 0, row: 0, selected: true, car: { name: "SPEEDTAIL", year: 2019, manufacturer: "MCLAREN" }, nameComplete: true,
				rarity: "EPIC", performance: { class: "A", pi: 700 }, drivetrain: "AWD", tires: "Street Tires", issues: [],
			});
			const second = await readCard(image, cards[1]!, worker, shapeWorker, templates);
			expect(second).toMatchObject({
				car: { name: "AUTODELTA TIPO 33/2 D", year: 1968, manufacturer: "ALFA ROMEO" }, nameComplete: false,
				rarity: "LEGENDARY", performance: { class: "R", pi: 998 }, drivetrain: "FWD", tires: "Slick Tires",
			});
			expect(second.issues).toEqual(["Name or manufacturer is cut off with an ellipsis on the card."]);
			const third = await readCard(image, cards[2]!, worker, shapeWorker, templates);
			expect(third).toMatchObject({ rarity: "COMMON", drivetrain: null, tires: null });
			expect(third.issues).toEqual([expect.stringContaining("Unknown drivetrain icon"), expect.stringContaining("Unknown tires icon")]);
		} finally {
			await Promise.all([worker.terminate(), shapeWorker.terminate()]);
		}
	}, 60000);
});
