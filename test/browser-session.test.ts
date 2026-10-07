import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { launchSyncBrowser, kudosPrimeProfileDirectory } from "../src/sites/browser-session.ts";
import { kudosPrimeAdapter } from "../src/sites/kudosprime/adapter.ts";
import { forzaGarageAdapter } from "../src/sites/forzagarage/adapter.ts";

const mocks = vi.hoisted(() => {
	const persistent = { close: vi.fn(async () => {}), addInitScript: vi.fn(async (_script: () => void) => {}) };
	const temporary = { close: vi.fn(async () => {}) };
	const browser = { newContext: vi.fn(async () => temporary), close: vi.fn(async () => {}) };
	return { persistent, temporary, browser,
		launch: vi.fn(async () => browser),
		launchPersistentContext: vi.fn(async () => persistent) };
});

vi.mock("playwright", () => ({ chromium: {
	launch: mocks.launch, launchPersistentContext: mocks.launchPersistentContext,
} }));

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

test("KudosPrime uses an isolated reusable profile outside the run and closes its context", async () => {
	vi.stubEnv("LOCALAPPDATA", "C:\\test-user\\AppData\\Local");
	const directory = join("C:\\test-user\\AppData\\Local", "fh-scanner", "browser-profiles", "kudosprime");
	assert.equal(kudosPrimeProfileDirectory(), directory);
	const session = await launchSyncBrowser(kudosPrimeAdapter);
	assert.equal(session.context, mocks.persistent);
	assert.deepEqual(mocks.launchPersistentContext.mock.calls, [[directory, {
		channel: "msedge", headless: false,
		ignoreDefaultArgs: ["--enable-automation"],
		args: ["--disable-blink-features=AutomationControlled"],
	}]]);
	assert.equal(mocks.persistent.addInitScript.mock.calls.length, 1);
	assert.equal(mocks.launch.mock.calls.length, 0);
	await session.close();
	assert.equal(mocks.persistent.close.mock.calls.length, 1);
});

test("ForzaGarage retains a temporary browser and closes the whole browser", async () => {
	const session = await launchSyncBrowser(forzaGarageAdapter);
	assert.equal(session.context, mocks.temporary);
	assert.deepEqual(mocks.launch.mock.calls, [[{ channel: "msedge", headless: false }]]);
	assert.equal(mocks.launchPersistentContext.mock.calls.length, 0);
	assert.equal(mocks.persistent.addInitScript.mock.calls.length, 0);
	await session.close();
	assert.equal(mocks.browser.close.mock.calls.length, 1);
});

test("persistent profile launch errors retain the underlying failure and profile guidance", async () => {
	mocks.launchPersistentContext.mockRejectedValueOnce(new Error("Profile in use"));
	await assert.rejects(launchSyncBrowser(kudosPrimeAdapter), /dedicated KudosPrime Edge profile.*Profile in use/);
	assert.equal(mocks.launch.mock.calls.length, 0);
});

test("temporary context creation failures close the launched browser and surface the error", async () => {
	mocks.browser.newContext.mockRejectedValueOnce(new Error("Cannot create context"));
	await assert.rejects(launchSyncBrowser(forzaGarageAdapter), /Cannot create context/);
	assert.equal(mocks.browser.close.mock.calls.length, 1);
});

test("KudosPrime initialization failures close the persistent context and surface the error", async () => {
	mocks.persistent.addInitScript.mockRejectedValueOnce(new Error("Initialization failed"));
	await assert.rejects(launchSyncBrowser(kudosPrimeAdapter), /Initialization failed/);
	assert.equal(mocks.persistent.close.mock.calls.length, 1);
});
