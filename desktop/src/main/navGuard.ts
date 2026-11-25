/**
 * Where each web view may go. The Cerea window may load the chosen server's origin and nothing
 * else; a link to anywhere else opens in the system browser. The one exception is signing in: a
 * server-side redirect that starts on the server's origin may take the window to the identity
 * provider (https only) and back, and nothing the user clicks on that page can leave it for a
 * third site. The browser panel loads http(s) pages only.
 */

export type Decision = "allow" | "external" | "deny";

export interface GuardState {
	/** The chosen server's origin; empty when none is chosen yet (the Cerea window loads nothing). */
	origin: string;
	/** The identity provider's origin from the server's sign-in settings: the only other origin a redirect may reach. */
	idp?: string;
	/** Set while the window is on an identity provider reached by a redirect from the server. */
	excursion?: { origin: string; since: number };
}

const EXCURSION_MS = 10 * 60 * 1000;

function parse(url: string): URL | undefined {
	try {
		return new URL(url);
	} catch {
		return undefined;
	}
}

const isWeb = (u: URL) => u.protocol === "https:" || u.protocol === "http:";

function secureOrLoopback(u: URL): boolean {
	if (u.protocol === "https:") return true;
	return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
}

export type NavKind = "navigate" | "redirect" | "window-open";

/** The Cerea window: what to do with a navigation to `url`, started from `from`. */
export function guardCerea(
	state: GuardState,
	kind: NavKind,
	url: string,
	from: string,
	now = Date.now()
): {
	decision: Decision;
	excursion?: GuardState["excursion"] | null;
} {
	const u = parse(url);
	if (!u || !state.origin) return { decision: "deny" };
	if (u.origin === state.origin) return { decision: "allow", excursion: null };
	if (!isWeb(u)) return { decision: "deny" };
	if (kind === "window-open") return { decision: "external" };
	const f = parse(from);
	const live =
		state.excursion && now - state.excursion.since < EXCURSION_MS ? state.excursion : undefined;
	// Only the server's own identity provider is reachable, and only by a redirect: a provider
	// upstream of it is not (an administrator will be able to list more hops later).
	if (kind === "redirect" && f && secureOrLoopback(u) && state.idp && u.origin === state.idp) {
		if (f.origin === state.origin)
			return { decision: "allow", excursion: { origin: u.origin, since: now } };
		if (live && f.origin === live.origin)
			return { decision: "allow", excursion: { origin: u.origin, since: live.since } };
	}
	if (kind === "navigate" && live && f && f.origin === live.origin && u.origin === live.origin) {
		return { decision: "allow" };
	}
	return { decision: "external" };
}

/** The browser panel: http(s) and the blank page. Everything else is refused, never opened. */
export function guardPanel(url: string): Decision {
	if (url === "about:blank") return "allow";
	const u = parse(url);
	return u && isWeb(u) ? "allow" : "deny";
}

/** Whether `url` may be handed to the system browser (a link out of the Cerea window). */
export function mayOpenExternally(url: string): boolean {
	const u = parse(url);
	return !!u && (u.protocol === "https:" || u.protocol === "http:" || u.protocol === "mailto:");
}

/** The Content-Security-Policy of the local UI pages. */
export const UI_CSP =
	"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
