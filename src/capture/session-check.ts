/**
 * Best-effort detection of a signed-out cloud gaming session. The check only looks at the page URL:
 * when a session expires, GeForce Now and Xbox Cloud send the tab to the provider's sign-in page.
 * It never reads page content or handles credentials.
 */

/** Hosts that only serve sign-in pages. Matched exactly or as a parent domain. */
const signInHosts = [
	"login.nvidia.com",
	"login.live.com",
	"login.microsoftonline.com",
];

/** Sign-in routes that live on the provider's own site (for example Xbox's Microsoft account hand-off). */
const signInRoutes: Array<{ host: string; path: RegExp }> = [
	{ host: "xbox.com", path: /^\/(?:[a-z]{2}-[A-Z]{2}\/)?auth(?:\/|$)/ },
];

function hostMatches(hostname: string, host: string): boolean {
	return hostname === host || hostname.endsWith(`.${host}`);
}

/** True when the URL is a known provider sign-in page. Unparseable and blank URLs are not sign-in pages. */
export function isSignInPage(pageUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(pageUrl);
	} catch {
		return false;
	}
	const hostname = url.hostname.toLowerCase();
	if (signInHosts.some((host) => hostMatches(hostname, host))) return true;
	return signInRoutes.some((route) => hostMatches(hostname, route.host) && route.path.test(url.pathname));
}

/** Throws a message that names the fix when the page has been sent to a sign-in page. */
export function assertSignedIn(pageUrl: string, provider: string): void {
	if (isSignInPage(pageUrl)) {
		throw new Error(`The ${provider} session has expired: the browser is showing a sign-in page. ` +
			`Sign in again with "npm run capture:cloud -- ${provider} --login", then restart the run.`);
	}
}
