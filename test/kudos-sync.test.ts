import assert from "node:assert/strict";
import { test } from "vitest";
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
