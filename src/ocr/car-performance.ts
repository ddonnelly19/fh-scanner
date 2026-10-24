import sharp from "sharp";
import type { Region } from "sharp";
import { PSM } from "tesseract.js";
import type { Worker } from "tesseract.js";

export const ratingNames = ["speed", "handling", "acceleration", "launch", "braking", "offroad"] as const;
export type RatingName = typeof ratingNames[number];
export const detailNames = ["power", "torque", "weight", "front", "displacement"] as const;
export type DetailName = typeof detailNames[number];
export interface Measurement {
	value: number;
	unit: "hp" | "kW" | "PS" | "ft-lb" | "Nm" | "lb" | "kg" | "%" | "l" | "cc";
}
export interface TextEvidence {
	text: string;
	confidence: number;
}
export interface CarPerformance {
	screen: "my-cars";
	panel: "ratings" | "details";
	car: { name: string; year: number; manufacturer: string } | null;
	ratings: Record<RatingName, number | null>;
	details: Record<DetailName, Measurement | null> | null;
	performance: { class: string; pi: number } | null;
	drivetrain: string | null;
	tires: string | null;
	evidence: Record<string, TextEvidence>;
	issues: string[];
}

export function parseMeasurement(field: DetailName, text: string): Measurement | null {
	const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(hp|kw|ps|ft[·.\s-]*lb|nm|n[·.\s-]*m|lbs?|kg|%|l|cc)$/i.exec(text.trim());
	if (!match) return null;
	const value = Number(match[1]!.replaceAll(",", "") + (match[2] === undefined ? "" : `.${match[2]}`));
	const rawUnit = match[3]!.toLowerCase().replace(/[·.\s-]/g, "");
	const units: Record<string, Measurement["unit"]> = {
		hp: "hp", kw: "kW", ps: "PS", ftlb: "ft-lb", nm: "Nm", lb: "lb", lbs: "lb",
		kg: "kg", "%": "%", l: "l", cc: "cc",
	};
	const unit = units[rawUnit];
	const allowed: Record<DetailName, readonly Measurement["unit"][]> = {
		power: ["hp", "kW", "PS"], torque: ["ft-lb", "Nm"], weight: ["lb", "kg"],
		front: ["%"], displacement: ["l", "cc"],
	};
	if (!unit || !allowed[field].includes(unit) || !Number.isFinite(value) ||
		(field === "front" ? value < 0 || value > 100 : value <= 0)) return null;
	return { value, unit };
}

export function parseRating(text: string): number | null {
	const normalized = text.trim().replace(",", ".");
	if (!/^(?:\d(?:\.\d)?|10(?:\.0)?)$/.test(normalized)) return null;
	const value = Number(normalized);
	return value >= 0 && value <= 10 ? value : null;
}

export function parsePerformance(text: string): CarPerformance["performance"] {
	const match = /^(D|C|B|A|S1|S2|X)\s*(\d{3,4})$/.exec(text.trim().toUpperCase());
	if (!match) return null;
	const pi = Number(match[2]);
	if (pi < 100 || pi > 999) return null;
	return { class: match[1]!, pi };
}

export function parseCarIdentity(text: string): CarPerformance["car"] {
	const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
	if (lines.length < 2) return null;
	const details = /^(19\d{2}|20\d{2})\s+(.+)$/.exec(lines.at(-1)!);
	if (!details) return null;
	return { name: lines.slice(0, -1).join(" "), year: Number(details[1]), manufacturer: details[2]! };
}

export async function findSelectedTile(image: Buffer): Promise<Region> {
	const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
	const runs: Array<{ left: number; top: number; width: number }> = [];
	for (let y = Math.floor(info.height * 0.18); y < info.height * 0.9; y++) {
		let start = -1;
		for (let x = Math.floor(info.width * 0.21); x <= info.width; x++) {
			const offset = (y * info.width + x) * info.channels;
			const selected = x < info.width && data[offset]! > 160 &&
				data[offset + 1]! > 210 && data[offset + 2]! < 100;
			if (selected && start < 0) start = x;
			if (!selected && start >= 0) {
				if (x - start > info.width * 0.1) runs.push({ left: start, top: y, width: x - start });
				start = -1;
			}
		}
	}
	for (const top of runs) {
		const bottom = runs.find((run) => Math.abs(run.left - top.left) <= 5 &&
			Math.abs(run.width - top.width) <= 10 &&
			run.top - top.top > info.height * 0.15 && run.top - top.top < info.height * 0.3);
		if (bottom) return { left: top.left, top: top.top, width: top.width, height: bottom.top - top.top + 1 };
	}
	throw new Error("Cannot locate the highlighted My Cars tile. Select a car and hide streaming overlays.");
}

export async function extractCarPerformance(image: Buffer, worker: Worker): Promise<CarPerformance> {
	const { width, height } = await sharp(image).metadata();
	if (!width || !height || Math.abs(width / height - 16 / 9) > 0.03) {
		throw new Error("My Cars extraction requires a game-only 16:9 screenshot without letterboxing.");
	}
	const evidence: Record<string, TextEvidence> = {};
	async function read(key: string, region: Region, mode: PSM, lightText: boolean, whitelist = "",
		scale: { height?: number; threshold?: number } = {}): Promise<string> {
		let crop = sharp(image).removeAlpha().extract(region)
			.resize(scale.height ? { height: scale.height } : region.width < 25 ? { height: 120 } : { width: Math.max(region.width * 3, 600) })
			.grayscale();
		// A threshold isolates white text on a coloured badge, where normalising keeps the badge colour as noise.
		crop = scale.threshold ? crop.threshold(scale.threshold) : crop.normalise();
		if (lightText) crop = crop.negate();
		const prepared = await crop.png().toBuffer();
		const input = await sharp(prepared).extend({ top: 15, bottom: 15, left: 15, right: 15, background: "white" }).png().toBuffer();
		await worker.setParameters({ tessedit_pageseg_mode: mode, tessedit_char_whitelist: whitelist });
		const { data } = await worker.recognize(input);
		evidence[key] = { text: data.text.trim(), confidence: data.confidence };
		return data.text.trim();
	}
	function region(left: number, top: number, areaWidth: number, areaHeight: number): Region {
		return {
			left: Math.round(left / 1365 * width!),
			top: Math.round(top / 768 * height!),
			width: Math.round(areaWidth / 1365 * width!),
			height: Math.round(areaHeight / 768 * height!),
		};
	}
	try {
		const title = await read("screen", region(98, 76, 91, 24), PSM.SINGLE_LINE, true);
		if (!/^mycars$/i.test(title.replace(/\s/g, ""))) throw new Error(`Expected My Cars screen; OCR read "${title}".`);
		const tile = await findSelectedTile(image);
		const identity = await read("car", {
			left: tile.left + Math.round(tile.width * 0.04),
			top: tile.top + Math.round(tile.height * 0.04),
			width: Math.round(tile.width * 0.92),
			height: Math.round(tile.height * 0.24),
		}, PSM.SINGLE_BLOCK, false);
		const issues: string[] = [];
		const car = parseCarIdentity(identity);
		if (!car) issues.push("Could not read the selected car's name, year and manufacturer.");
		const firstLabel = await read("panelLabel", region(89, 351, 110, 27), PSM.SINGLE_LINE, true);
		const normalizedLabel = firstLabel.toLowerCase().replace(/\s/g, "");
		if (normalizedLabel !== "speed" && normalizedLabel !== "power") {
			throw new Error(`Cannot recognize My Cars stats panel ("${firstLabel}"). Show ratings or details with L.`);
		}
		const panel = normalizedLabel === "speed" ? "ratings" : "details";
		const ratings: CarPerformance["ratings"] = {
			speed: null, handling: null, acceleration: null, launch: null, braking: null, offroad: null,
		};
		let details: CarPerformance["details"] = null;
		if (panel === "ratings") {
			for (const [index, name] of ratingNames.entries()) {
				const top = 351 + index * 32;
				const label = await read(`${name}Label`, region(89, top, 146, 27), PSM.SINGLE_LINE, true);
				// Width-based upscaling of these small crops made streamed 5s read as 0 or 9; a fixed height reads them reliably.
				const value = await read(name, region(240, top, 39, 27), PSM.SINGLE_LINE, true, "0123456789.", { height: 100 });
				ratings[name] = label.toLowerCase().replace(/\s/g, "") === name ? parseRating(value) : null;
				if (ratings[name] === null) issues.push(`Could not verify ${name} rating (label "${label}", value "${value}").`);
			}
		} else {
			details = { power: null, torque: null, weight: null, front: null, displacement: null };
			for (const [index, name] of detailNames.entries()) {
				const top = 351 + index * 32;
				const label = await read(`${name}Label`, region(89, top, 110, 27), PSM.SINGLE_LINE, true);
				const value = await read(name, region(201, top, 78, 27), PSM.SINGLE_LINE, true);
				details[name] = label.toLowerCase().replace(/\s/g, "") === name ? parseMeasurement(name, value) : null;
				// Narrow unit glyphs can resemble digits; re-read them separately rather than substituting characters.
				if (details[name] === null && label.toLowerCase().replace(/\s/g, "") === name &&
					(name === "weight" || name === "displacement")) {
					const unitLeft = name === "weight" ? 261 : 270;
					const unitText = await read(`${name}Unit`, region(unitLeft, top, 279 - unitLeft, 27),
						name === "weight" ? PSM.SINGLE_LINE : PSM.SINGLE_CHAR, true);
					// Only normalize letter-shaped unit glyphs in the isolated unit crop, never numeric text.
					const unit = unitText.replace(/^[I|](?=b?$)/, "l");
					if (unit === (name === "weight" ? "lb" : "l")) {
						const number = await read(`${name}Value`, region(201, top, unitLeft - 202, 27),
							PSM.SINGLE_LINE, true, "0123456789.,");
						details[name] = parseMeasurement(name, `${number} ${unit}`);
					}
				}
				if (details[name] === null) issues.push(`Could not verify ${name} measurement (label "${label}", value "${value}").`);
			}
		}
		// The class letter is white on a class-coloured badge, so it is read apart from the PI digits beside it.
		const performanceClass = await read("performanceClass", region(94, 597, 26, 24), PSM.SINGLE_BLOCK, true, "DCBASX12",
			{ height: 100, threshold: 230 });
		const performancePI = await read("performance", region(126, 597, 40, 24), PSM.SINGLE_LINE, true, "0123456789", { height: 100 });
		const performance = parsePerformance(`${performanceClass} ${performancePI}`);
		if (!performance) issues.push("Could not read class and PI.");
		const driveText = await read("drivetrain", region(181, 598, 45, 24), PSM.SINGLE_LINE, false);
		const drivetrain = /^(AWD|RWD|FWD)$/.test(driveText) ? driveText : null;
		if (!drivetrain) issues.push(`Could not read drivetrain ("${driveText}").`);
		let tires: string | null = null;
		if (panel === "ratings") {
			const tireText = await read("tires", region(122, 550, 156, 29), PSM.SINGLE_LINE, true);
			tires = /\btires\b/i.test(tireText) ? tireText : null;
			if (!tires) issues.push(`Could not read tire description ("${tireText}").`);
		}
		for (const [field, item] of Object.entries(evidence)) {
			if (item.confidence < 60) issues.push(`Low OCR confidence for ${field}: ${item.confidence.toFixed(1)}.`);
		}
		return { screen: "my-cars", panel, car, ratings, details, performance, drivetrain, tires, evidence, issues };
	} finally {
		await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO, tessedit_char_whitelist: "" });
	}
}
