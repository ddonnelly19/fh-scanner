import type { Page } from "playwright";

/**
 * Both cloud players show the game as WebRTC video in the page. Reading frames from the video element gives the
 * stream at its own resolution (1440p or more) whatever the size of the window, where a page screenshot is capped by
 * the window and scaled by it. The same peer connection reports what the stream is actually delivering.
 */

/** Added to every page before its scripts run: remembers each RTCPeerConnection so its stats can be read later. */
export const streamInitScript = `(() => {
	const Original = window.RTCPeerConnection;
	if (!Original || Original.__fhWrapped) return;
	const peers = [];
	window.__fhPeers = peers;
	function Wrapped(...args) {
		const peer = new Original(...args);
		peers.push(peer);
		return peer;
	}
	Wrapped.prototype = Original.prototype;
	Object.setPrototypeOf(Wrapped, Original);
	Wrapped.__fhWrapped = true;
	window.RTCPeerConnection = Wrapped;
})();`;

export interface StreamStats {
	/** Size of the decoded video frames. */
	width: number;
	height: number;
	framesPerSecond: number | null;
	/** Received video bitrate since the previous reading, in megabits per second. */
	megabitsPerSecond: number | null;
	framesDropped: number | null;
	packetsLost: number | null;
	jitterMs: number | null;
	codec: string | null;
}

/** The video stats of the live stream, or null when the page has no connected stream. */
export async function readStreamStats(page: Page): Promise<StreamStats | null> {
	return page.evaluate(async () => {
		const state = window as unknown as { __fhPeers?: RTCPeerConnection[]; __fhLastBytes?: { bytes: number; time: number } };
		for (const peer of [...(state.__fhPeers ?? [])].reverse()) {
			if (peer.connectionState === "closed") continue;
			const report = await peer.getStats();
			let video: Record<string, unknown> | undefined;
			report.forEach((entry: Record<string, unknown>) => {
				if (entry.type === "inbound-rtp" && entry.kind === "video" && (!video || Number(entry.bytesReceived) > Number(video.bytesReceived))) video = entry;
			});
			if (!video || !video.frameWidth) continue;
			const bytes = Number(video.bytesReceived);
			const time = Number(video.timestamp);
			const last = state.__fhLastBytes;
			state.__fhLastBytes = { bytes, time };
			const codec = typeof video.codecId === "string" ? report.get(video.codecId) as { mimeType?: string } | undefined : undefined;
			const number = (value: unknown) => typeof value === "number" ? value : null;
			return {
				width: Number(video.frameWidth), height: Number(video.frameHeight),
				framesPerSecond: number(video.framesPerSecond),
				megabitsPerSecond: last && time > last.time ? Math.round((bytes - last.bytes) * 8 / (time - last.time) / 100) / 10 : null,
				framesDropped: number(video.framesDropped), packetsLost: number(video.packetsLost),
				jitterMs: typeof video.jitter === "number" ? Math.round(video.jitter * 1000) : null,
				codec: codec?.mimeType ?? null,
			};
		}
		return null;
	});
}

/** One line for the terminal, e.g. "2560x1440 at 60 fps, 28.4 Mbps, H264". */
export function describeStreamStats(stats: StreamStats): string {
	const size = `${stats.width}x${stats.height}${stats.framesPerSecond !== null ? ` at ${stats.framesPerSecond} fps` : ""}`;
	return [size, stats.megabitsPerSecond !== null ? `${stats.megabitsPerSecond} Mbps` : null, stats.codec?.replace(/^video\//, "") ?? null,
		stats.framesDropped ? `${stats.framesDropped} frames dropped` : null, stats.packetsLost ? `${stats.packetsLost} packets lost` : null]
		.filter(Boolean).join(", ");
}

/**
 * The current frame of the largest playing video, as a PNG at the video's own resolution, or null when there is no
 * playing video. WebRTC video isn't cross-origin, so the canvas can be read back. A smaller JPEG (width and type)
 * is several times quicker to make and is enough to tell whether the screen is still moving.
 */
export async function captureStreamFrame(page: Page, options: { width?: number; type?: "png" | "jpeg" } = {}): Promise<Buffer | null> {
	const dataUrl = await page.evaluate(({ width, type }) => {
		const videos = [...document.querySelectorAll("video")].filter((video) => video.videoWidth > 0 && !video.paused && !video.ended);
		const video = videos.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
		if (!video) return null;
		const canvas = document.createElement("canvas");
		const scale = width ? Math.min(1, width / video.videoWidth) : 1;
		canvas.width = Math.round(video.videoWidth * scale);
		canvas.height = Math.round(video.videoHeight * scale);
		const context = canvas.getContext("2d");
		if (!context) return null;
		context.drawImage(video, 0, 0, canvas.width, canvas.height);
		return type === "jpeg" ? canvas.toDataURL("image/jpeg", 0.9) : canvas.toDataURL("image/png");
	}, { width: options.width ?? 0, type: options.type ?? "png" });
	return dataUrl ? Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64") : null;
}
