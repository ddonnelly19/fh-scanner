import assert from "node:assert/strict";
import { test } from "vitest";
import { chromium } from "playwright";
import { parseGaragePlan } from "../src/sites/garage-plan.ts";
import { kudosPrimeAdapter, validateGarageResponse } from "../src/sites/kudosprime/adapter.ts";

test("sync plan only accepts unique explicit site IDs and traceable entries", () => {
	const car = { id: "4", name: "2002 ACURA RSX TYPE-S", sources: ["tiles\\one.png"] };
	assert.deepEqual(parseGaragePlan({ owned: [car], review: ["unresolved"] }, kudosPrimeAdapter), [car]);
	assert.deepEqual(parseGaragePlan({ owned: [] }, kudosPrimeAdapter), []);
	for (const plan of [null, {}, { owned: [car, car] }, { owned: [{ ...car, id: "kudosprime:4" }] },
		{ owned: [{ ...car, sources: [] }] }, { owned: [{ ...car, id: "0" }] }]) {
		assert.throws(() => parseGaragePlan(plan, kudosPrimeAdapter));
	}
});

test("only explicit API success is accepted, not login HTML, errors or success-shaped responses", () => {
	assert.doesNotThrow(() => validateGarageResponse(200, '{"success":true}'));
	for (const [status, body] of [[401, '{"success":true}'], [302, ""], [200, "<html>Login</html>"],
		[200, '{"success":false}'], [200, '{"success":1}'], [200, '{}'], [200, 'null']] as const) {
		assert.throws(() => validateGarageResponse(status, body));
	}
});

test("garage failures expose the site's bounded error code and message", () => {
	assert.throws(() => validateGarageResponse(400, JSON.stringify({
		success: false, code: "garage.saveFailed", message: "Failed to update garage.",
	})), /HTTP 400 \(garage.saveFailed: Failed to update garage\.\)/);
	assert.throws(() => validateGarageResponse(200, '{"success":false,"message":"Request rejected"}'), /Request rejected/);
	assert.throws(() => validateGarageResponse(400, "<html>verification</html>"), /HTTP 400/);
});

test("KudosPrime reads owned/missing lists through the session and fails closed", async () => {
	const browser = await chromium.launch({ channel: "msedge", headless: true });
	try {
		const page = await browser.newPage();
		const lists: Record<string, string | undefined> = {
			y: '<div id="carlist"><div class="car" data-carid="1"></div><div class="car" data-carid="2"></div></div>',
			n: '<div id="carlist"><div class="car" data-carid="3"></div></div>',
		};
		const requests: string[] = [];
		await page.route("https://www.kudosprime.com/**", async (route) => {
			const url = new URL(route.request().url());
			if (route.request().method() === "POST") {
				requests.push(route.request().postData() ?? "");
				await route.fulfill({ status: 200, contentType: "application/json", body: '{"success":true}' });
			} else {
				await route.fulfill({ contentType: "text/html", body: lists[url.searchParams.get("garage") ?? ""] ?? "<html></html>" });
			}
		});
		await page.goto(kudosPrimeAdapter.loginUrl);
		assert.deepEqual([...await kudosPrimeAdapter.loadOwnedIds!(page, ["1", "3"])], ["1", "2"]);
		await assert.rejects(kudosPrimeAdapter.loadOwnedIds!(page, ["1", "4"]), /car 4.*No additions sent/);
		lists.n = lists.y;
		await assert.rejects(kudosPrimeAdapter.loadOwnedIds!(page, ["1"]), /overlap/);
		lists.y = "<html>Performing security verification</html>";
		await assert.rejects(kudosPrimeAdapter.loadOwnedIds!(page, ["1"]), /no car list.*No additions sent/);
		assert.deepEqual(requests, []);
		await kudosPrimeAdapter.addOwned(page, "3");
		assert.deepEqual(requests, ["action=add&set=1&car=3"]);
		await page.route("**/api.php?*", route => route.fulfill({
			status: 400, contentType: "application/json",
			body: '{"success":false,"code":"garage.saveFailed","message":"Failed to update garage."}',
		}));
		await assert.rejects(kudosPrimeAdapter.addOwned(page, "3"), /HTTP 400.*garage.saveFailed/);
	} finally {
		await browser.close();
	}
}, 30000);
