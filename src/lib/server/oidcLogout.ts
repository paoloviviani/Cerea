/**
 * Signing out when the identity provider publishes no `end_session_endpoint`.
 *
 * The bundled Authelia (4.39) does not, so a sign-out used to clear this app's
 * session and nothing else: the redirect home re-ran the login, Authelia's
 * still-live SSO session answered it without a prompt, and the person was back
 * as themselves. `OPENID_LOGOUT_URL` names the provider's own logout page
 * instead — `<issuer>/logout?rd={redirect}` for Authelia, which `pystino init`
 * writes — with `{redirect}` replaced by where to land afterwards.
 *
 * And one sign-out covers the whole origin: the console lives beside the chat
 * on the Pystino stack, so `LOGOUT_ALSO_CLEAR_COOKIES` names its session cookies
 * (`name` or `name:path`) to expire too. Otherwise signing out here would leave
 * the console signed in — and the console does the same for this app.
 */

/** The provider logout URL from a template, `{redirect}` filled in (URL-encoded). */
export function fillLogoutTemplate(template: string, redirect: string): string {
	return template.trim().replaceAll("{redirect}", encodeURIComponent(redirect));
}

/** `gw_session,gw_idt:/auth` → the cookies to expire, each with its path. */
export function cookiesToClear(spec: string): { name: string; path: string }[] {
	return spec
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean)
		.map((item) => {
			const [name, path] = item.split(":");
			return { name: name.trim(), path: path?.trim() || "/" };
		})
		.filter((cookie) => cookie.name);
}
