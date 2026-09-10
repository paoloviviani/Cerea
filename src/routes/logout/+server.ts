/**
 * Signing out, at both ends.
 *
 * The local session goes first — deleted server-side, cookie cleared — so that
 * a provider round trip which never completes still leaves this app signed
 * out. Then, if the provider advertises an `end_session_endpoint`, the browser
 * is sent there to end the directory's own session and comes back here.
 *
 * Without that second half, signing out did nothing observable: the cookie was
 * cleared, the redirect to `/` re-ran the OIDC flow, and the provider's own
 * still-live session signed the person straight back in with no prompt. That
 * was found by a live check, not by a unit test — nothing in-process can see
 * a browser following a redirect into a directory that remembers it.
 *
 * `POST` only, and that is deliberate: a GET would make signing somebody out
 * something a prefetch, a link preview or an `<img>` could do to them.
 */

import { base } from "$app/paths";
import { collections } from "$lib/server/database";
import { redirect } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { sameSite, secure, getOIDCLogoutUrl } from "$lib/server/auth";

export async function POST({ locals, cookies, url }) {
	// Read before the session row goes: the id token identifies the session
	// being ended, and the provider needs it to honour the redirect back.
	const session = await collections.sessions.findOne({ sessionId: locals.sessionId });
	const idToken = session?.oauth?.idToken;

	await collections.sessions.deleteOne({ sessionId: locals.sessionId });

	cookies.delete(config.COOKIE_NAME, {
		path: "/",
		// So that it works inside the space's iframe
		sameSite,
		secure,
		httpOnly: true,
	});

	const origin = config.PUBLIC_ORIGIN || url.origin;
	const home = `${origin}${base}/`;
	const providerLogout = await getOIDCLogoutUrl(
		{ redirectURI: `${origin}${base}/login/callback` },
		{ url, idToken, postLogoutRedirectUri: home }
	);

	return redirect(302, providerLogout ?? `${base}/`);
}
