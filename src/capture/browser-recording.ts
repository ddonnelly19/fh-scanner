import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export type RecordingCommand =
	| { type: "capture"; label: string }
	| { type: "key"; key: string; holdMs: number }
	| { type: "wait"; milliseconds: number }
	| { type: "done" }
	| { type: "help" };

export function parseRecordingCommand(input: string): RecordingCommand {
	const [command, ...args] = input.trim().split(/\s+/);
	if (command === "capture") return { type: "capture", label: args.join(" ") };
	if ((command === "done" || command === "help") && !args.length) return { type: command };
	if (command === "wait" && args.length === 1 && /^\d+$/.test(args[0]!)) {
		const milliseconds = Number(args[0]);
		if (milliseconds >= 1 && milliseconds <= 30000) return { type: "wait", milliseconds };
	}
	if (command === "key" && args.length >= 1 && args.length <= 2) {
		const key = args[0]!;
		const parts = key.split("+");
		const modifiers = parts.slice(0, -1);
		const base = parts.at(-1)!;
		const validBase = /^[a-zA-Z0-9]$/.test(base) || /^(?:F[1-9]|F1[0-2])$/.test(base) ||
			["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Backspace",
				"Tab", "Space", "Home", "End", "PageUp", "PageDown", "Delete", "Insert"].includes(base);
		const holdMs = args[1] === undefined ? 100 : /^\d+$/.test(args[1]) ? Number(args[1]) : NaN;
		if (validBase && modifiers.every((modifier) => ["Control", "Shift", "Alt", "Meta"].includes(modifier)) &&
			new Set(modifiers).size === modifiers.length && holdMs >= 1 && holdMs <= 5000) {
			return { type: "key", key, holdMs };
		}
	}
	throw new Error("Use: capture [label], key <Playwright key> [hold-ms 1..5000], wait <ms 1..30000>, help, done.");
}

interface RecordingActions {
	capture(): Promise<Buffer>;
	press(key: string, holdMs: number): Promise<void>;
	wait(milliseconds: number): Promise<void>;
}

interface RecordingEvent {
	sequence: number;
	startedAt: string;
	completedAt?: string;
	status: "pending" | "completed" | "failed";
	command: Exclude<RecordingCommand, { type: "done" | "help" }>;
	screenshot?: string;
	settleMs?: number;
	error?: string;
}

export class BrowserRecording {
	private manifest: {
		schemaVersion: number;
		provider: string;
		startedAt: string;
		finishedAt?: string;
		status: "recording" | "completed" | "interrupted";
		events: RecordingEvent[];
	};
	private captures = 0;
	private directory: string;
	private actions: RecordingActions;

	constructor(directory: string, provider: string, actions: RecordingActions) {
		this.directory = directory;
		this.actions = actions;
		this.manifest = { schemaVersion: 1, provider, startedAt: new Date().toISOString(), status: "recording", events: [] };
	}

	async save(): Promise<void> {
		const temporary = join(this.directory, "recording.json.tmp");
		await writeFile(temporary, JSON.stringify(this.manifest, null, 2));
		await rename(temporary, join(this.directory, "recording.json"));
	}

	async execute(command: RecordingEvent["command"]): Promise<void> {
		if (this.manifest.status !== "recording") throw new Error("Recording is already closed.");
		const event: RecordingEvent = {
			sequence: this.manifest.events.length + 1,
			startedAt: new Date().toISOString(),
			status: "pending",
			command,
		};
		if (command.type === "capture") event.screenshot = `screen-${String(++this.captures).padStart(4, "0")}.png`;
		if (command.type === "key") event.settleMs = 500;
		this.manifest.events.push(event);
		await this.save();
		try {
			if (command.type === "capture") {
				await writeFile(join(this.directory, event.screenshot!), await this.actions.capture());
			} else if (command.type === "key") {
				await this.actions.press(command.key, command.holdMs);
				await this.actions.wait(event.settleMs!);
			} else {
				await this.actions.wait(command.milliseconds);
			}
			event.status = "completed";
			event.completedAt = new Date().toISOString();
		} catch (error) {
			event.status = "failed";
			event.error = error instanceof Error ? error.message : String(error);
			this.manifest.status = "interrupted";
			await this.save();
			throw error;
		}
		await this.save();
	}

	async finish(completed: boolean): Promise<void> {
		this.manifest.status = completed && this.manifest.status === "recording" ? "completed" : "interrupted";
		this.manifest.finishedAt = new Date().toISOString();
		await this.save();
	}
}
