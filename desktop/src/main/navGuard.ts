/**
 * Where each web view may go. The Cerea window may load the chosen server's origin and nothing
 * else; a link to anywhere else opens in the system browser. The one exception is signing in: a
 * server-side redirect that starts on the server's origin may take the window to the identity
 * provider (https only) and back. While that sign-in is live (10 minutes from the first hop, never
 * extended), the provider may hand over to providers upstream of it (GitLab signing in through
 * Microsoft, say), but only by a server-side redirect from the page the window is on, https only,
 * and at most `MAX_UPSTREAM` origins beyond the provider. A click or a script on any of those pages
 * moves only between origins the sign-in already reached; a new one opens in the system browser.
 * The browser panel loads http(s) pages only.
 */

export type Decision = "allow" | "external" | "deny";

export interface GuardState {
	/** The chosen server's origin; empty when none is chosen yet (the Cerea window loads nothing). */
	origin: string;
	/** The identity provider's origin from the server's sign-in settings: the only other origin a redirect may reach. */
	idp?: string;
	/**
	 * Set while the window is signing in: the origin it is on now, when the sign-in started (the
	 * first redirect to the provider), and every origin the sign-in reached, the provider first.
	 */
	excursion?: { origin: string; since: number; chain?: string[] };
}

const EXCURSION_MS = 10 * 60 * 1000;
/** How many origins beyond the server's own provider a sign-in may reach (upstream providers). */
export const MAX_UPSTREAM = 3;

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

/**
 * The source of the navigation chain a view is running, tracked per view. A redirect can start
 * from a page that has not committed yet (the first `loadURL` of a profile: nothing is loaded, so
 * `wc.getURL()` is empty), and the chain needs the exact URL it started from and every hop of it
 * — never the view's current URL. This remembers it: the URL the view was loaded at, then the
 * URL of every allowed navigation or redirect.
 */
export class NavChain {
	/** The URL the current chain started at, or the last allowed hop of it. */
	private from: string;

	constructor(initialUrl: string) {
		this.from = initialUrl;
	}

	/** The URL the next navigation or redirect of this chain started from. */
	source(): string {
		return this.from;
	}

	/**
	 * A redirect, as `will-redirect` reports it: only the main frame's count. A frame's redirect is
	 * the frame's business (the guard does not stop it, nor open it outside): it must neither use up
	 * a sign-in hop, nor move the chain away from the page the window is on, nor start a sign-in
	 * from a frame of the server's login page. Undefined for a frame.
	 */
	redirect(
		state: GuardState,
		url: string,
		isMainFrame: boolean,
		now = Date.now()
	): ReturnType<typeof guardCerea> | undefined {
		return isMainFrame ? this.handle(state, "redirect", url, now) : undefined;
	}

	/** The guard decision for a navigation to `url`, and the chain's new source when allowed. */
	handle(
		state: GuardState,
		kind: NavKind,
		url: string,
		now = Date.now()
	): ReturnType<typeof guardCerea> {
		const r = guardCerea(state, kind, url, this.from, now);
		// An allowed navigation commits the page: the next hop starts from it. A refused one
		// follows nothing, so the chain stays where it is.
		if (r.decision === "allow") this.from = url;
		return r;
	}
}

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
	const reached = live ? (live.chain ?? [live.origin]) : [];
	// The sign-in starts with a redirect from the server to its own identity provider (a fresh
	// sign-in, so a fresh clock).
	if (
		kind === "redirect" &&
		f &&
		f.origin === state.origin &&
		secureOrLoopback(u) &&
		state.idp &&
		u.origin === state.idp
	) {
		return {
			decision: "allow",
			excursion: { origin: u.origin, since: now, chain: [u.origin] },
		};
	}
	// Everything else needs a live sign-in, and starts from the page the window is on.
	if (!live || !f || f.origin !== live.origin) return { decision: "external" };
	// Between origins the sign-in already reached: by redirect, or by a click or a script (the
	// upstream provider posting its answer back to the server's provider).
	if (reached.includes(u.origin) && (kind === "redirect" || secureOrLoopback(u))) {
		return {
			decision: "allow",
			...(u.origin === live.origin
				? {}
				: { excursion: { origin: u.origin, since: live.since, chain: reached } }),
		};
	}
	// A new origin: only by a server-side redirect, https only, and within the cap. The clock is
	// the one the sign-in started with.
	if (kind === "redirect" && secureOrLoopback(u) && reached.length < 1 + MAX_UPSTREAM) {
		return {
			decision: "allow",
			excursion: { origin: u.origin, since: live.since, chain: [...reached, u.origin] },
		};
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
