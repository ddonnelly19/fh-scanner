import { execFile } from "node:child_process";
import { promisify } from "node:util";
import screenshot from "screenshot-desktop";
import sharp from "sharp";
import { getCarTileRegions } from "./car-tiles.ts";

const execFileAsync = promisify(execFile);

export interface Bounds {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface CaptureDisplay extends Bounds {
	id: string | number;
}

function isBounds(value: unknown): value is Bounds {
	return typeof value === "object" && value !== null &&
		"left" in value && typeof value.left === "number" && Number.isFinite(value.left) &&
		"top" in value && typeof value.top === "number" && Number.isFinite(value.top) &&
		"width" in value && typeof value.width === "number" && Number.isFinite(value.width) && value.width > 0 &&
		"height" in value && typeof value.height === "number" && Number.isFinite(value.height) && value.height > 0;
}

function isCaptureDisplay(value: unknown): value is CaptureDisplay {
	return isBounds(value) && "id" in value && (typeof value.id === "string" || typeof value.id === "number");
}

export async function getPhysicalWindowBounds(windowHandle: number): Promise<Bounds> {
	if (!Number.isSafeInteger(windowHandle) || windowHandle <= 0) {
		throw new Error(`Invalid window handle: ${windowHandle}`);
	}

	// DWM returns physical coordinates, unlike DPI-virtualized GetWindowRect.
	const command = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ScannerWindowBounds {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("dwmapi.dll")]
    public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT rect, int size);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hwnd);
}
'@
$handle = [IntPtr]${windowHandle}
if ([ScannerWindowBounds]::IsIconic($handle)) { throw 'Target window is minimized. Restore it before scanning.' }
$rect = New-Object ScannerWindowBounds+RECT
$result = [ScannerWindowBounds]::DwmGetWindowAttribute($handle, 9, [ref]$rect, 16)
if ($result -ne 0) { throw "Could not read physical window bounds (HRESULT $result)." }
@{ left = $rect.Left; top = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top } | ConvertTo-Json -Compress
`;
	const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
		windowsHide: true,
		timeout: 10000,
	});
	const bounds: unknown = JSON.parse(stdout);
	if (!isBounds(bounds)) {
		throw new Error(`Target window has invalid physical bounds: ${stdout.trim()}`);
	}
	return bounds;
}

function intersection(window: Bounds, display: Bounds): Bounds {
	const left = Math.max(window.left, display.left);
	const top = Math.max(window.top, display.top);
	return {
		left,
		top,
		width: Math.max(0, Math.min(window.left + window.width, display.left + display.width) - left),
		height: Math.max(0, Math.min(window.top + window.height, display.top + display.height) - top),
	};
}

export function selectCaptureDisplay(window: Bounds, displays: readonly CaptureDisplay[]): CaptureDisplay {
	if (!isBounds(window) || displays.some((display) => !isCaptureDisplay(display))) {
		throw new Error("Invalid window or display bounds.");
	}
	let selected: CaptureDisplay | undefined;
	let largestArea = 0;
	for (const display of displays) {
		const overlap = intersection(window, display);
		const area = overlap.width * overlap.height;
		if (area > largestArea) {
			largestArea = area;
			selected = display;
		}
	}
	if (!selected) {
		throw new Error(`Target window does not intersect a display: ${JSON.stringify(window)}`);
	}
	return selected;
}

export function getCaptureCrop(window: Bounds, display: CaptureDisplay, imageWidth: number, imageHeight: number): Bounds {
	if (!isBounds(window) || !isCaptureDisplay(display) ||
		!Number.isSafeInteger(imageWidth) || imageWidth <= 0 ||
		!Number.isSafeInteger(imageHeight) || imageHeight <= 0) {
		throw new Error("Invalid bounds or screenshot dimensions.");
	}
	const overlap = intersection(window, display);
	if (overlap.width <= 0 || overlap.height <= 0) {
		throw new Error("Target window is outside the captured display.");
	}
	const scaleX = imageWidth / display.width;
	const scaleY = imageHeight / display.height;
	const left = Math.max(0, Math.floor((overlap.left - display.left) * scaleX));
	const top = Math.max(0, Math.floor((overlap.top - display.top) * scaleY));
	const right = Math.min(imageWidth, Math.ceil((overlap.left + overlap.width - display.left) * scaleX));
	const bottom = Math.min(imageHeight, Math.ceil((overlap.top + overlap.height - display.top) * scaleY));
	if (right <= left || bottom <= top) {
		throw new Error("Target window has no capturable pixels.");
	}
	return { left, top, width: right - left, height: bottom - top };
}

export async function cropWindowImage(rawBuffer: Buffer, crop: Bounds): Promise<Buffer> {
	return sharp(rawBuffer).extract(crop).png().toBuffer();
}

export async function preprocessScreenshotForOCR(screenshotBuffer: Buffer): Promise<Buffer> {
	return sharp(screenshotBuffer).grayscale().linear(1.5, -0.2).resize({ width: 2000 }).toBuffer();
}

async function carNameSamples(image: Buffer): Promise<Buffer[]> {
	const { width, height } = await sharp(image).metadata();
	if (!width || !height) throw new Error("Cannot compare a screenshot without image dimensions.");
	const samples: Buffer[] = [];
	for (const region of getCarTileRegions(width, height)) {
		samples.push(await sharp(image).extract(region.textBounds)
			.resize(250, 40).grayscale().blur(0.5).raw().toBuffer());
	}
	return samples;
}

export async function isSameCarPage(previous: Buffer, current: Buffer): Promise<boolean> {
	const [before, after] = await Promise.all([carNameSamples(previous), carNameSamples(current)]);
	return before.every((sample, index) => {
		const other = after[index];
		if (!other || other.length !== sample.length) throw new Error("Inconsistent car-name sample dimensions.");
		let totalDifference = 0;
		let changedPixels = 0;
		for (let pixel = 0; pixel < sample.length; pixel++) {
			const difference = Math.abs(sample[pixel]! - other[pixel]!);
			totalDifference += difference;
			if (difference > 25) changedPixels++;
		}
		return totalDifference / sample.length <= 3 && changedPixels / sample.length <= 0.01;
	});
}

export async function captureWindowScreenshot(windowHandle: number): Promise<Buffer> {
	const bounds = await getPhysicalWindowBounds(windowHandle);
	const displays: unknown[] = await screenshot.listDisplays();
	if (!displays.every(isCaptureDisplay)) {
		throw new Error("Screen capture did not return usable Windows display bounds.");
	}
	const display = selectCaptureDisplay(bounds, displays);
	const rawBuffer = await screenshot({ format: "png", screen: display.id });
	const image = sharp(rawBuffer);
	const { width, height } = await image.metadata();
	if (!width || !height) {
		throw new Error("Could not read screenshot dimensions.");
	}
	const crop = getCaptureCrop(bounds, display, width, height);
	return cropWindowImage(rawBuffer, crop);
}
