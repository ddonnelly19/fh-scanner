import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BrowserRecording, parseRecordingCommand } from "../src/capture/browser-recording.ts";

describe("browser recording commands", () => {
	it("parses captures, keys, modifiers, delays and completion", () => {
		expect(parseRecordingCommand("capture detail panel")).toEqual({ type: "capture", label: "detail panel" });
		expect(parseRecordingCommand("key p")).toEqual({ type: "key", key: "p", holdMs: 100 });
		expect(parseRecordingCommand("key Shift+ArrowRight 200")).toEqual({ type: "key", key: "Shift+ArrowRight", holdMs: 200 });
		expect(parseRecordingCommand("wait 1500")).toEqual({ type: "wait", milliseconds: 1500 });
		expect(parseRecordingCommand("done")).toEqual({ type: "done" });
		expect(parseRecordingCommand("help")).toEqual({ type: "help" });
	});
	it("rejects invalid or unbounded commands", () => {
		for (const command of ["", "p", "key", "key Unknown", "key p 0", "key p 5001",
			"key p 1.5", "key p 100 extra", "key Shift+Shift+p", "wait -1", "wait 30001", "done extra"]) {
			expect(() => parseRecordingCommand(command)).toThrow("Use:");
		}
	});
});

describe("persistent browser recording", () => {
	it("persists ordered captures and the inputs between them before sending actions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "fh-recording-test-"));
		const calls: string[] = [];
		try {
			const recording = new BrowserRecording(directory, "geforce", {
				capture: async () => { calls.push("capture"); return Buffer.from("image"); },
				press: async (key, holdMs) => {
					const persisted = JSON.parse(await readFile(join(directory, "recording.json"), "utf8"));
					expect(persisted.events.at(-1).status).toBe("pending");
					calls.push(`${key}:${holdMs}`);
				},
				wait: async (ms) => { calls.push(`wait:${ms}`); },
			});
			await recording.save();
			await recording.execute({ type: "capture", label: "ratings" });
			await recording.execute({ type: "key", key: "p", holdMs: 100 });
			await recording.execute({ type: "wait", milliseconds: 1500 });
			await recording.execute({ type: "capture", label: "details" });
			await recording.finish(true);
			const manifest = JSON.parse(await readFile(join(directory, "recording.json"), "utf8"));
			expect(manifest.status).toBe("completed");
			expect(manifest.events.map((event: { sequence: number; status: string; command: { type: string } }) =>
				[event.sequence, event.status, event.command.type])).toEqual([
				[1, "completed", "capture"], [2, "completed", "key"], [3, "completed", "wait"], [4, "completed", "capture"],
			]);
			expect(manifest.events[1].settleMs).toBe(500);
			expect(manifest.events[3].screenshot).toBe("screen-0002.png");
			expect(await readFile(join(directory, "screen-0002.png"), "utf8")).toBe("image");
			expect(calls).toEqual(["capture", "p:100", "wait:500", "wait:1500", "capture"]);
			expect(await readdir(directory)).not.toContain("recording.json.tmp");
			await expect(recording.execute({ type: "capture", label: "" })).rejects.toThrow("closed");
		} finally {
			await rm(directory, { recursive: true });
		}
	});
	it("retains failed input evidence and marks incomplete runs as interrupted", async () => {
		const directory = await mkdtemp(join(tmpdir(), "fh-recording-failure-"));
		try {
			const recording = new BrowserRecording(directory, "xbox", {
				capture: async () => Buffer.from("image"),
				press: async () => { throw new Error("Browser closed"); },
				wait: async () => {},
			});
			await recording.execute({ type: "capture", label: "initial" });
			await expect(recording.execute({ type: "key", key: "p", holdMs: 100 })).rejects.toThrow("Browser closed");
			await recording.finish(false);
			const manifest = JSON.parse(await readFile(join(directory, "recording.json"), "utf8"));
			expect(manifest.status).toBe("interrupted");
			expect(manifest.events[1].status).toBe("failed");
			expect(manifest.events[1].error).toBe("Browser closed");
			expect(await readFile(join(directory, "screen-0001.png"), "utf8")).toBe("image");
		} finally {
			await rm(directory, { recursive: true });
		}
	});
});
