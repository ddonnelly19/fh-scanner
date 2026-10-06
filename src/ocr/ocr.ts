import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createWorker, OEM } from "tesseract.js";
import type { Worker } from "tesseract.js";

const require = createRequire(import.meta.url);

export async function createLocalOCRWorker(): Promise<Worker> {
	const langPath = join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int");
	await access(join(langPath, "eng.traineddata.gz"));

	// Tesseract 7 does not reject createWorker for every initialization error.
	return new Promise<Worker>((resolve, reject) => {
		createWorker("eng", OEM.LSTM_ONLY, {
			langPath,
			cacheMethod: "none",
			errorHandler: (error: unknown) => {
				reject(new Error("Tesseract OCR worker failed", { cause: error }));
			},
		}).then(resolve, reject);
	});
}
