import { base } from "$app/paths";

/**
 * Whether the person's sign-in is too old for /code — one shared flag, so
 * every part of the panel agrees on it at once.
 *
 * The server refuses every /code request but `/status` with `401
 * {code:"reauth_required"}` while the sign-in is older than 7 days
 * (`hooks/handle.ts`). This store is the client's half of that: the first
 * answer that says so — a `/code` call, an event stream's closing frame, a
 * terminal socket — flips `required`, and the panel reacts everywhere by
 * dropping what it holds. `freshUntil` (from `/status`) arms a timer that
 * flips the same flag when the window closes, so a tab left open needs no
 * request to find out.
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
	/** `/status` has answered at least once, or a refusal already did. */
	checked: false,
	/** Where [Sign in] goes (carries the app base path). The server's word
	 * once `/status` has answered; this default is the same path. */
	reauthPath: `${base}/login?reauth=1&next=${base}/code`,
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
	if (codeReauth.required) return;
	codeReauth.required = true;
	for (const listener of listeners) listener();
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
}

/** Fold a `/status` answer in. Fresh: clears the flag and arms the timer.
 * Stale: flags. A `fresh` answer is how a returning person (after signing in
 * again) gets the panel back. */
export function applyCodeStatus(status: CodeStatus): void {
	codeReauth.reauthPath = status.reauthPath;
	if (!status.fresh) {
		flagCodeReauth(status.reauthPath);
		return;
	}
	codeReauth.checked = true;
	codeReauth.required = false;
	if (status.freshUntil) armUntil(new Date(status.freshUntil).getTime());
}

/** Test seam: back to the state of a page that has not asked yet. */
export function resetCodeReauth(): void {
	disarm();
	codeReauth.required = false;
	codeReauth.checked = false;
	codeReauth.reauthPath = `${base}/login?reauth=1&next=${base}/code`;
}
