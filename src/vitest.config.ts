import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	root: fileURLToPath(new URL("..", import.meta.url)),
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		// The OCR smoke test changes cwd, which is unsupported in worker threads.
		pool: "forks",
		testTimeout: 30000,
	},
});
