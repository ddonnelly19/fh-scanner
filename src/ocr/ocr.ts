import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createWorker, OEM } from "tesseract.js";
import type { Worker } from "tesseract.js";

const require = createRequire(import.meta.url);

/**
 * "lstm" is the neural line recognizer used for most text. "legacy" is Tesseract's older shape-based
 * character classifier; it has no language model, so it does not rewrite digits to fit a likely word.
 */
export type OCREngine = "lstm" | "legacy";

export async function createLocalOCRWorker(engine: OCREngine = "lstm"): Promise<Worker> {
	const worker = await createEngineWorker(engine);
	// The legacy classifier adapts to every page it reads, which made a streamed % read as 070 only after a few cars.
	if (engine === "legacy") await worker.setParameters({ classify_enable_learning: "0" });
	return worker;
}

async function createEngineWorker(engine: OCREngine): Promise<Worker> {
	// Only the full 4.0.0 model carries the legacy classifier; best_int is LSTM-only.
	const langPath = join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), engine === "lstm" ? "4.0.0_best_int" : "4.0.0");
	await access(join(langPath, "eng.traineddata.gz"));

	// Tesseract 7 does not reject createWorker for every initialization error.
	return new Promise<Worker>((resolve, reject) => {
		createWorker("eng", engine === "lstm" ? OEM.LSTM_ONLY : OEM.TESSERACT_ONLY, {
			langPath,
			cacheMethod: "none",
			errorHandler: (error: unknown) => {
				reject(new Error("Tesseract OCR worker failed", { cause: error }));
			},
		}).then(resolve, reject);
	});
}
