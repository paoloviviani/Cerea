import { base } from "$app/paths";

/**
 * Whether the person's sign-in is too old for /code — one shared flag, so
 * every part of the panel agrees on it at once.
 *
 * Two different reasons hide the panel, and they must not share a message.
 * `required` is the stale sign-in (older than 7 days): the server refuses
 * every /code request but `/status` with `401 {code:"reauth_required"}`
 * (`hooks/handle.ts`). `signedOut` is no session at all — the ordinary
 * hourly expiry of a chat without a refresh token, seen on the next stream
 * reconnect or a return to an open tab. It sets `required` too (there is no
 * session, so the panel's hide-and-drop-everything still applies), but the
 * way back is a plain sign-in, never the forced `reauth=1` password prompt.
 *
 * This store is the client's half of the guard: the first answer that says
 * so — a `/code` call, an event stream's closing frame, a terminal
 * socket — flips the flags, and the panel reacts everywhere by dropping
 * what it holds. `freshUntil` (from `/status`) arms a timer that flips the
 * stale flag when the window closes, so a tab left open needs no request
 * to find out.
 *
 * The panel draws nothing from the machines while `required` is set: no
 * device tree, no Needs-you inbox, no counts, no terminal tab. Composer
 * drafts stay in localStorage (they are the person's own words), but nothing
 * shows them.
 *
 * `checked` is false until `/status` has answered once, so a surface can
 * wait for the answer instead of firing requests the server will refuse.
 */
export const codeReauth = $state({
	/** The sign-in is stale (or was just found to be). */
	required: false,
	/** There is no signed-in session at all (distinct from stale). */
	signedOut: false,
	/** `/status` has answered at least once, or a refusal already did. */
	checked: false,
	/** Where [Sign in] goes (carries the app base path). The server's word
	 * once `/status` has answered; this default is the same path. */
	reauthPath: `${base}/login?reauth=1&next=${base}/code`,
	/** Where the signed-out way back goes: a plain sign-in, so the
	 * provider's SSO session answers silently instead of asking for the
	 * password. */
	signInPath: `${base}/login?next=${base}/code`,
});

type Listener = () => void;
const listeners = new Set<Listener>();

/** Run `listener` whenever the sign-in is found stale. Stores that hold
 * machine-derived state register here to drop it, so this module needs to
 * import none of them (they import the API, which imports this). */
export function onCodeReauth(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

let timer: ReturnType<typeof setTimeout> | null = null;

function disarm() {
	if (timer) clearTimeout(timer);
	timer = null;
}

/** A /code answer said the sign-in is stale. Idempotent. */
export function flagCodeReauth(reauthPath?: string): void {
	disarm();
	if (reauthPath) codeReauth.reauthPath = reauthPath;
	codeReauth.checked = true;
	codeReauth.signedOut = false;
	if (codeReauth.required) return;
	codeReauth.required = true;
	for (const listener of listeners) listener();
}

/** No signed-in session at all. Sets `required` too, so every hide-and-drop
 * reaction fires exactly as for stale — but records `signedOut`, so the
 * panel offers the plain sign-in instead of the forced one. Idempotent. */
export function flagCodeSignedOut(signInPath?: string): void {
	disarm();
	if (signInPath) codeReauth.signInPath = signInPath;
	codeReauth.checked = true;
	codeReauth.signedOut = true;
	if (codeReauth.required) return;
	codeReauth.required = true;
	for (const listener of listeners) listener();
}

/** Send a signed-out page through the plain sign-in, so the provider's SSO
 * session answers silently and the person lands back on /code. Guarded
 * against a loop: a redirect that already happened in the last minute means
 * signing back in is not working (cookies blocked, IdP session gone without
 * a login page to say so), so the card stays instead. Returns whether the
 * page is leaving. Never throws (private-mode storage, SSR, tests). */
const SIGNOUT_REDIRECT_KEY = "code-signedout-redirect-at";
const SIGNOUT_REDIRECT_GUARD_MS = 60_000;

/** Test seam: the signed-out redirect's side effect (default: leave the
 * page for the plain sign-in). */
export const signOutRedirect = {
	go(path: string): void {
		window.location.assign(path);
	},
};

export function maybeRedirectSignedOut(now: number = Date.now()): boolean {
	if (typeof window === "undefined") return false;
	let last = 0;
	try {
		last = Number(window.sessionStorage.getItem(SIGNOUT_REDIRECT_KEY) ?? 0);
	} catch {
		return false;
	}
	if (now - last < SIGNOUT_REDIRECT_GUARD_MS) return false;
	try {
		window.sessionStorage.setItem(SIGNOUT_REDIRECT_KEY, String(now));
	} catch {
		return false;
	}
	signOutRedirect.go(codeReauth.signInPath);
	return true;
}

const MAX_TIMER_MS = 2 ** 31 - 1;

function armUntil(freshUntilMs: number) {
	disarm();
	const wait = freshUntilMs - Date.now();
	if (wait <= 0) {
		flagCodeReauth();
		return;
	}
	// A timer cannot exceed ~24.8 days; the window is 7, but re-arm rather
	// than trust a far-future `freshUntil` to fire early.
	timer = setTimeout(() => armUntil(freshUntilMs), Math.min(wait, MAX_TIMER_MS));
}

export interface CodeStatus {
	enabled: boolean;
	fresh: boolean;
	reauthPath: string;
	freshUntil?: string;
	/** Present on a current server: whether anyone is signed in at all. */
	signedIn?: boolean;
	/** Present on a current server: the plain (unforced) way back. */
	signInPath?: string;
}

/** Fold a `/status` answer in. Fresh: clears both flags and arms the timer.
 * Signed in but stale: the stale flag. Not signed in: the signed-out flag,
 * and the page leaves for the plain sign-in unless it just did. A status
 * without `signedIn` (an older server) keeps the old behaviour: not fresh
 * means stale. A `fresh` answer is how a returning person (after signing in
 * again) gets the panel back. */
export function applyCodeStatus(status: CodeStatus): void {
	codeReauth.reauthPath = status.reauthPath;
	if (status.signInPath) codeReauth.signInPath = status.signInPath;
	if (!status.fresh) {
		if (status.signedIn === false) {
			flagCodeSignedOut(status.signInPath);
			maybeRedirectSignedOut();
			return;
		}
		flagCodeReauth(status.reauthPath);
		return;
	}
	codeReauth.checked = true;
	codeReauth.required = false;
	codeReauth.signedOut = false;
	if (status.freshUntil) armUntil(new Date(status.freshUntil).getTime());
}

/** Test seam: back to the state of a page that has not asked yet. */
export function resetCodeReauth(): void {
	disarm();
	codeReauth.required = false;
	codeReauth.signedOut = false;
	codeReauth.checked = false;
	codeReauth.reauthPath = `${base}/login?reauth=1&next=${base}/code`;
	codeReauth.signInPath = `${base}/login?next=${base}/code`;
}
