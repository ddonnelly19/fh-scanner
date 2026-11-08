import { describe, expect, it } from "vitest";
import { pickDisplay } from "../src/capture/displays.ts";
import type { Display } from "../src/capture/displays.ts";

// DELL9393's layout on 2026-11-08: laptop panel, a TV, the primary ultrawide and a portable screen.
const screens: Display[] = [
	{ name: "\\\\.\\DISPLAY1", primary: false, internal: true, x: 334, y: 1080, width: 1280, height: 853 },
	{ name: "\\\\.\\DISPLAY2", primary: false, internal: false, x: -3840, y: -14, width: 1920, height: 1080 },
	{ name: "\\\\.\\DISPLAY3", primary: true, internal: false, x: 0, y: 0, width: 2560, height: 1080 },
	{ name: "\\\\.\\DISPLAY4", primary: false, internal: false, x: 2560, y: -14, width: 1536, height: 864 },
];

describe("pickDisplay", () => {
	it("prefers the built-in screen and falls back to the primary one", () => {
		expect(pickDisplay(screens, "internal")?.name).toBe("\\\\.\\DISPLAY1");
		expect(pickDisplay(screens.filter((screen) => !screen.internal), "internal")?.name).toBe("\\\\.\\DISPLAY3");
	});
	it("picks the primary screen or a numbered one", () => {
		expect(pickDisplay(screens, "Primary")?.name).toBe("\\\\.\\DISPLAY3");
		expect(pickDisplay(screens, "2")?.x).toBe(-3840);
		expect(pickDisplay(screens, "9")).toBeUndefined();
	});
	it("leaves placement to Edge when no screens are known, and rejects unknown names", () => {
		expect(pickDisplay([], "internal")).toBeUndefined();
		expect(() => pickDisplay(screens, "left")).toThrow("Unknown --display");
	});
});
