import sharp from "sharp";
import { PSM } from "tesseract.js";
import type { Worker } from "tesseract.js";
import type { CapturedCarText } from "../collection/car-matching.ts";

export interface OwnershipEvidence {
	status: "owned" | "unowned" | "unknown";
	labelText: string;
}

export function classifyOwnership(labelText: string): OwnershipEvidence {
	const words = labelText.toUpperCase().replace(/[^A-Z]+/g, " ").trim().split(/\s+/);
	const hasRarity = words.some((word) => ["COMMON", "RARE", "EPIC", "LEGENDARY"].includes(word));
	const hasPlaceholder = words.includes("DISCOVER") || words.includes("JAPAN");
	return {
		status: hasPlaceholder ? "unowned" : hasRarity ? "owned" : "unknown",
		labelText,
	};
}

export async function detectTileOwnership(image: Buffer, worker: Worker): Promise<OwnershipEvidence> {
	const { width, height } = await sharp(image).metadata();
	if (!width || !height) throw new Error("Ownership detection requires image dimensions.");
	async function recognizeArea(left: number, top: number, areaWidth: number, areaHeight: number, threshold: number): Promise<string> {
		const label = await sharp(image).extract({
			left: Math.round(width! * left), top: Math.round(height! * top),
			width: Math.round(width! * areaWidth), height: Math.round(height! * areaHeight),
		}).resize({ width: 1000 }).grayscale().normalise().threshold(threshold)
			.extend({ top: 20, bottom: 20, left: 20, right: 20, background: "white" }).png().toBuffer();
		return (await worker.recognize(label)).data.text;
	}
	await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
	try {
		const rarity = await recognizeArea(0.055, 0.072, 0.34, 0.086, 220);
		const placeholder = await recognizeArea(0.163, 0.354, 0.682, 0.154, 220);
		return classifyOwnership(`${rarity}\n${placeholder}`);
	} finally {
		await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
	}
}

export interface OwnedCarInput extends CapturedCarText {
	ownership: OwnershipEvidence;
}
