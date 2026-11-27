/**
 * The profile's home page in the browser panel: the Cerea chat of that profile. The address is
 * stored normalized (its base path included, e.g. "/chat"); the home is the address itself
 * when it already carries that path, otherwise the address with a "/chat" suffix.
 */
export function homeUrl(address: string): string {
	const base = address.replace(/\/+$/, "");
	return base.endsWith("/chat") ? base : `${base}/chat`;
}

/** origin + path of a web URL, without its query, hash or a trailing slash; blank on a bad URL. */
function originPath(url: string): string {
	try {
		const u = new URL(url);
		return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
	} catch {
		return "";
	}
}

/** Whether the panel is at home right now: the active tab shows the profile's home page. */
export function isAtHome(activeUrl: string | undefined, address: string): boolean {
	if (!address || !activeUrl) return false;
	const active = originPath(activeUrl);
	return !!active && active === originPath(homeUrl(address));
}

/**
 * Whether the Home button shows: the panel has an active page, the profile has a home page, and
 * that page is not it. An at-home page carries no Home button.
 */
export function homeButtonVisible(
	activeUrl: string | undefined,
	address: string | undefined
): boolean {
	return !!address && !!activeUrl && !isAtHome(activeUrl, address);
}
