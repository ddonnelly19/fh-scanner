import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import sharp from "sharp";
import { captureStreamFrame, describeStreamStats, readStreamStats, streamInitScript } from "../src/capture/stream-frame.ts";

/**
 * A stand-in for a cloud player: a 1280x720 canvas animation sent over a loopback WebRTC connection and played in a
 * small 160x90 video, so a frame read from the video must come back at the stream's size, not the element's.
 */
const player = `<!doctype html><body style="margin:0"><video id="v" autoplay muted playsinline width="160" height="90"></video><script>
	const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
	const context = canvas.getContext("2d");
	let tick = 0;
	setInterval(() => { context.fillStyle = "#c00"; context.fillRect(0, 0, 1280, 720); context.fillStyle = "#fff"; context.fillRect(tick++ % 1000, 300, 200, 120); }, 30);
	const sender = new RTCPeerConnection(); const receiver = new RTCPeerConnection();
	sender.onicecandidate = (event) => event.candidate && receiver.addIceCandidate(event.candidate);
	receiver.onicecandidate = (event) => event.candidate && sender.addIceCandidate(event.candidate);
	receiver.ontrack = (event) => { const video = document.getElementById("v"); video.srcObject = event.streams[0]; video.play(); };
	const stream = canvas.captureStream(30);
	for (const track of stream.getTracks()) sender.addTrack(track, stream);
	(async () => {
		await sender.setLocalDescription(await sender.createOffer()); await receiver.setRemoteDescription(sender.localDescription);
		await receiver.setLocalDescription(await receiver.createAnswer()); await sender.setRemoteDescription(receiver.localDescription);
	})();
</script></body>`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
	// The container has Playwright's Chromium; DELL9393 runs Edge.
	browser = await chromium.launch().catch(() => chromium.launch({ channel: "msedge" }));
	page = await browser.newPage();
	await page.addInitScript(streamInitScript);
	// Served at a URL rather than set as content, so the init script runs before the page's scripts as it would on
	// the real player.
	await page.route("http://player.test/", (route) => route.fulfill({ contentType: "text/html", body: player }));
	await page.goto("http://player.test/");
	// WebRTC starts at a low resolution and raises it as the connection's bandwidth estimate grows.
	await page.waitForFunction(() => (document.getElementById("v") as HTMLVideoElement).videoWidth >= 640, undefined, { timeout: 25000 });
}, 40000);
// Edge can take well over the default 10 s to shut down after a WebRTC session.
afterAll(async () => { await browser?.close(); }, 60000);

describe("stream capture", () => {
	it("reads a frame at the stream's resolution, not the video element's size", async () => {
		const frame = await captureStreamFrame(page);
		expect(frame).not.toBeNull();
		const { width, height } = await sharp(frame!).metadata();
		const shown = await page.evaluate(() => { const video = document.getElementById("v") as HTMLVideoElement; return [video.videoWidth, video.videoHeight]; });
		expect([width, height]).toEqual(shown);
		expect(width).toBeGreaterThanOrEqual(640);
		const { channels } = await sharp(frame!).extract({ left: 0, top: 0, width: 100, height: 100 }).stats();
		expect(channels[0]!.mean).toBeGreaterThan(150);
		expect(channels[1]!.mean).toBeLessThan(60);
		// The quick probe used while waiting for the screen to settle is a smaller JPEG of the same frame.
		const probe = await sharp((await captureStreamFrame(page, { width: 320, type: "jpeg" }))!).metadata();
		expect(probe).toMatchObject({ format: "jpeg", width: 320, height: Math.round(shown[1]! * 320 / shown[0]!) });
	}, 20000);
	it("reports the stream's video stats", async () => {
		await readStreamStats(page);
		await page.waitForTimeout(1000);
		const stats = await readStreamStats(page);
		expect(stats!.width).toBeGreaterThanOrEqual(640);
		expect(stats!.width / stats!.height).toBeCloseTo(16 / 9, 1);
		expect(stats!.megabitsPerSecond).toBeGreaterThan(0);
		expect(describeStreamStats(stats!)).toMatch(/^\d+x\d+/);
	}, 20000);
	it("returns nothing on a page without a stream", async () => {
		const empty = await browser.newPage();
		await empty.addInitScript(streamInitScript);
		await empty.route("http://empty.test/", (route) => route.fulfill({ contentType: "text/html", body: "<p>no stream</p>" }));
		await empty.goto("http://empty.test/");
		expect(await captureStreamFrame(empty)).toBeNull();
		expect(await readStreamStats(empty)).toBeNull();
		await empty.close();
	});
});
