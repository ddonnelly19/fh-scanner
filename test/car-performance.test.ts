import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { extractCarPerformance, findSelectedTile, parseCarIdentity, parseMeasurement, parsePerformance, parseRating } from "../src/ocr/car-performance.ts";
import { createLocalOCRWorker } from "../src/ocr/ocr.ts";

describe("performance observations", () => {
	it("parses detail measurements with validated units and thousands separators", () => {
		expect(parseMeasurement("power", "1,126 hp")).toEqual({ value: 1126, unit: "hp" });
		expect(parseMeasurement("torque", "866 ft·lb")).toEqual({ value: 866, unit: "ft-lb" });
		expect(parseMeasurement("weight", "3,141 lb")).toEqual({ value: 3141, unit: "lb" });
		expect(parseMeasurement("front", "46%")).toEqual({ value: 46, unit: "%" });
		expect(parseMeasurement("displacement", "3.99 l")).toEqual({ value: 3.99, unit: "l" });
		expect(parseMeasurement("power", "840 kW")).toEqual({ value: 840, unit: "kW" });
		expect(parseMeasurement("torque", "1,174 N m")).toEqual({ value: 1174, unit: "Nm" });
		expect(parseMeasurement("weight", "1425 kg")).toEqual({ value: 1425, unit: "kg" });
		expect(parseMeasurement("displacement", "3990 cc")).toEqual({ value: 3990, unit: "cc" });
		for (const text of ["", "3.991", "3,14 lb", "-1 lb", "0 lb", "3141 hp", "3,1411b"]) {
			expect(parseMeasurement("weight", text)).toBeNull();
		}
		expect(parseMeasurement("front", "101%")).toBeNull();
		expect(parseMeasurement("displacement", "3.991")).toBeNull();
	});
	it("parses bounded ratings without guessing missing decimal points", () => {
		expect(parseRating("7.9")).toBe(7.9);
		expect(parseRating("6,8")).toBe(6.8);
		expect(parseRating("10")).toBe(10);
		for (const text of ["79", "-1", "10.1", "", "O", "7.9 extra"]) expect(parseRating(text)).toBeNull();
	});
	it("parses class and PI", () => {
		expect(parsePerformance("S2 900")).toEqual({ class: "S2", pi: 900 });
		expect(parsePerformance("B600")).toEqual({ class: "B", pi: 600 });
		for (const text of ["S3 900", "S2", "S2 1000", "A 99"]) expect(parsePerformance(text)).toBeNull();
	});
	it("reads identity from tile lines, including multiline names", () => {
		expect(parseCarIdentity("SPEEDTAIL\n2019 MCLAREN")).toEqual({ name: "SPEEDTAIL", year: 2019, manufacturer: "MCLAREN" });
		expect(parseCarIdentity("INTEGRA\nA-SPEC\n2023 ACURA")?.name).toBe("INTEGRA A-SPEC");
		expect(parseCarIdentity("SPEEDTAIL")).toBeNull();
	});
	it("locates a selection border without using the current-car banner", async () => {
		const image = await sharp({ create: { width: 1365, height: 768, channels: 3, background: "black" } })
			.composite([{ input: Buffer.from('<svg width="1365" height="768"><rect x="535" y="150" width="230" height="175" fill="none" stroke="#caff00" stroke-width="3"/></svg>') }])
			.png().toBuffer();
		const tile = await findSelectedTile(image);
		expect(tile.left).toBeGreaterThan(530);
		expect(tile.left).toBeLessThan(540);
		expect(tile.height).toBeGreaterThan(170);
	});
	it("rejects images without a selected tile", async () => {
		const image = await sharp({ create: { width: 1365, height: 768, channels: 3, background: "black" } }).png().toBuffer();
		await expect(findSelectedTile(image)).rejects.toThrow("highlighted");
	});
	it.each(["ratings", "details"] as const)("extracts %s using local OCR, not the current-car banner", async (panel) => {
		const labels = panel === "ratings" ? ["Speed", "Handling", "Acceleration", "Launch", "Braking", "Offroad"]
			: ["Power", "Torque", "Weight", "Front", "Displacement"];
		const values = panel === "ratings" ? ["7.9", "6.8", "10", "10", "8.5", "4.4"]
			: ["1,126 hp", "866 ft-lb", "3,141 lb", "46%", "3.99 l"];
		const rows = labels.map((label, index) =>
			`<text x="90" y="${371 + index * 32}" font-size="18">${label}</text>` +
			(panel === "ratings" ? `<text x="251" y="${371 + index * 32}" font-size="18">${values[index]}</text>`
				: `<text x="276" y="${371 + index * 32}" text-anchor="end" font-size="15">${values[index]}</text>`)).join("");
		const image = await sharp(Buffer.from(
			'<svg width="1365" height="768"><rect width="100%" height="100%" fill="black"/>' +
			'<g font-family="Arial" fill="white">' +
			'<text x="100" y="94" font-size="22">My Cars</text>' +
			'<text x="118" y="48" font-size="16">2020 DIFFERENT CURRENT CAR</text>' + rows +
			'<text x="123" y="570" font-size="12">Horizon Semi-Slick Tires</text>' +
			'<text x="93" y="616" font-size="20">S2 900</text></g>' +
			'<rect x="179" y="595" width="96" height="29" fill="white"/>' +
			'<text x="184" y="616" font-family="Arial" font-size="18">AWD</text>' +
			'<rect x="535" y="150" width="230" height="175" fill="white" stroke="#caff00" stroke-width="3"/>' +
			'<g font-family="Arial" text-anchor="middle" fill="black">' +
			'<text x="650" y="173" font-size="20">SPEEDTAIL</text>' +
			'<text x="650" y="191" font-size="17">2019 MCLAREN</text></g></svg>',
		)).png().toBuffer();
		const worker = await createLocalOCRWorker();
		try {
			const result = await extractCarPerformance(image, worker);
			expect(result.car).toEqual({ name: "SPEEDTAIL", year: 2019, manufacturer: "MCLAREN" });
			expect(result.panel).toBe(panel);
			if (panel === "ratings") {
				expect(result.ratings).toEqual({ speed: 7.9, handling: 6.8, acceleration: 10, launch: 10, braking: 8.5, offroad: 4.4 });
				expect(result.details).toBeNull();
				expect(result.tires).toBe("Horizon Semi-Slick Tires");
			} else {
				expect(result.details).toEqual({
					power: { value: 1126, unit: "hp" }, torque: { value: 866, unit: "ft-lb" },
					weight: { value: 3141, unit: "lb" }, front: { value: 46, unit: "%" },
					displacement: { value: 3.99, unit: "l" },
				});
				expect(Object.values(result.ratings)).toEqual(Array(6).fill(null));
				expect(result.tires).toBeNull();
			}
			expect(result.performance).toEqual({ class: "S2", pi: 900 });
			expect(result.drivetrain).toBe("AWD");
			expect(result.issues).toEqual(Object.entries(result.evidence)
				.filter(([, evidence]) => evidence.confidence < 60)
				.map(([field, evidence]) => `Low OCR confidence for ${field}: ${evidence.confidence.toFixed(1)}.`));
		} finally {
			await worker.terminate();
		}
	}, 30000);
});
