/**
 * Per-site allow and deny lists for browsing (ADR 0116 §4), an administrator setting.
 *
 * An entry is a host (`shop.example.com`), a wildcard (`*.example.com`) or a bare domain
 * (`example.com`, which covers its subdomains). A pasted URL is reduced to its host. The deny list
 * wins over the allow list; an unlisted site follows the defaults (commit asks).
 */

export interface SiteRules {
	allow: string[];
	deny: string[];
}

/** The host of a URL or a pasted entry, lower-cased, without port, `www.` kept (it is a real label). */
export function hostOf(input: string): string | undefined {
	const trimmed = input.trim();
	if (!trimmed || trimmed.startsWith("/")) return undefined;
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
		return url.hostname.toLowerCase().replace(/\.$/, "") || undefined;
	} catch {
		return undefined;
	}
}

/** Entries from a setting value: one per line or comma, hosts only, duplicates dropped. */
export function parseSiteList(value: string | undefined): string[] {
	const entries: string[] = [];
	for (const raw of (value ?? "").split(/[\n,]/)) {
		const text = raw.trim().toLowerCase();
		if (!text || text.startsWith("#")) continue;
		const wildcard = text.startsWith("*.");
		const host = hostOf(wildcard ? text.slice(2) : text);
		if (!host) continue;
		const entry = wildcard ? `*.${host}` : host;
		if (!entries.includes(entry)) entries.push(entry);
	}
	return entries;
}

/** Whether `host` is covered by one entry. A bare domain covers itself and its subdomains. */
export function hostMatches(host: string, entry: string): boolean {
	const h = host.toLowerCase();
	if (entry.startsWith("*.")) return h.endsWith(entry.slice(1)) && h.length > entry.length - 1;
	return h === entry || h.endsWith(`.${entry}`);
}

export function matchesAny(host: string | undefined, entries: string[]): boolean {
	return host !== undefined && entries.some((entry) => hostMatches(host, entry));
}
