import { describe, expect, it } from "vitest";
import { assertSignedIn, isSignInPage } from "../src/capture/session-check.ts";

describe("sign-in page detection", () => {
	it("recognizes provider sign-in hosts and routes", () => {
		for (const url of [
			"https://login.nvidia.com/signin?client_id=abc",
			"https://login.live.com/oauth20_authorize.srf?x=1",
			"https://login.microsoftonline.com/common/oauth2/authorize",
			"https://www.xbox.com/en-US/auth/msa?action=logIn",
			"https://www.xbox.com/auth/msa",
		]) {
			expect(isSignInPage(url), url).toBe(true);
		}
	});

	it("does not flag the streaming pages or unrelated URLs", () => {
		for (const url of [
			"https://play.geforcenow.com/mall/",
			"https://www.xbox.com/en-US/play",
			"https://www.xbox.com/play/games/forza-horizon-5/9NKX70BBCDRN",
			"https://www.xbox.com/en-US/authors",
			"https://example.com/login.nvidia.com",
			"about:blank",
			"",
			"not a url",
		]) {
			expect(isSignInPage(url), url).toBe(false);
		}
	});

	it("throws a message naming the provider and the login command when signed out", () => {
		expect(() => assertSignedIn("https://login.live.com/", "xbox")).toThrow(/xbox session has expired.*--login/);
		expect(() => assertSignedIn("https://play.geforcenow.com/mall/", "geforce")).not.toThrow();
	});
});
