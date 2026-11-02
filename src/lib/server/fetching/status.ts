/**
 * HTTP failures a fetch can name, and the one retry that sometimes fixes them.
 *
 * A site that answers 403, 404 or 410 for `/feed/` often serves `/feed` (and
 * the other way round): the trailing slash is part of the address a server
 * routes on. The model guesses one spelling and, told only "answered 403",
 * keeps guessing more. So a fetch retries once with the slash toggled, and a
 * failure says in words what the status usually means and what to do next.
 */

/** Statuses worth one retry with the slash toggled. */
export const SLASH_RETRY_STATUSES: ReadonlySet<number> = new Set([403, 404, 410]);

/**
 * The same address with its path's trailing slash toggled (`/a/` and `/a`),
 * keeping query and fragment, or null when there is nothing to toggle: the
 * bare origin, a file-like last segment (`/feed.xml`), or an unparseable URL.
 */
export function toggleTrailingSlash(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	const path = parsed.pathname;
	if (path === "/" || path === "") return null;
	if (path.endsWith("/")) {
		parsed.pathname = path.slice(0, -1);
		if (parsed.pathname === "") return null;
	} else {
		const last = path.split("/").pop() ?? "";
		if (/\.[a-z0-9]{1,5}$/i.test(last)) return null;
		parsed.pathname = `${path}/`;
	}
	return parsed.href;
}

/** The sentence the model reads for a failed status. Short, and says what to try next. */
export function statusFailureMessage(status: number, slashTried: boolean): string {
	const tried = slashTried
		? " The same address with the trailing slash toggled was tried too."
		: "";
	if (status === 403) {
		return (
			"The site refused this address (HTTP 403): it may block automated readers or not serve this exact path. " +
			"Try at most one other address, or open the site's homepage and follow its links, rather than guessing." +
			tried
		);
	}
	if (status === 404 || status === 410) {
		return (
			`No page at this address (HTTP ${status}). Open the homepage or search for the right address.` +
			tried
		);
	}
	return `That URL answered ${status}.${tried}`;
}

/** A non-2xx answer, carrying its status so a caller can decide what to do about it. */
export class FetchStatusError extends Error {
	constructor(
		readonly status: number,
		readonly slashTried = false
	) {
		super(statusFailureMessage(status, slashTried));
		this.name = "FetchStatusError";
	}
}
