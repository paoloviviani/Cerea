/**
 * Per-site allow and deny lists for browsing (ADR 0116 §4), an administrator setting.
 *
 * An entry is a host (`shop.example.com`), a wildcard (`*.example.com`) or a bare domain
 * (`example.com`, which covers its subdomains). A pasted URL is reduced to its host. The deny list
 * wins over the allow list; an unlisted site follows the defaults (commit asks).
 */

import { parse } from "tldts";

export interface SiteRules {
	allow: string[];
	deny: string[];
}

/**
 * The host of a URL or a pasted entry: lower-cased, without port, userinfo or a trailing dot, so
 * `Shop.Example.com.` and `shop.example.com` are one host everywhere it is compared.
 */
export function hostOf(input: string): string | undefined {
	const trimmed = input.trim();
	if (!trimmed || trimmed.startsWith("/")) return undefined;
	try {
		const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
		return url.hostname.toLowerCase().replace(/\.+$/, "") || undefined;
	} catch {
		return undefined;
	}
}

const psl = (host: string) => parse(host, { allowPrivateDomains: true });

/**
 * The site a host belongs to: its registrable domain by the public suffix list, private domains
 * included (so `a.github.io` and `b.github.io` are different sites). An IP literal or a host with
 * no registrable domain is its own site.
 */
export function siteOf(host: string): string {
	const h = host.toLowerCase().replace(/\.+$/, "");
	const parsed = psl(h);
	if (parsed.isIp) return h;
	return parsed.domain ?? h;
}

export function sameSite(a: string, b: string): boolean {
	return siteOf(a) === siteOf(b);
}

/** Whether an entry is itself a public suffix (`com`, `co.uk`, `github.io`): it would cover unrelated sites. */
export function isPublicSuffix(host: string): boolean {
	const parsed = psl(host.toLowerCase());
	return (
		!parsed.isIp && parsed.domain === null && (parsed.isIcann === true || parsed.isPrivate === true)
	);
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

/**
 * Whether `host` is covered by one entry. A bare domain covers itself and its subdomains. An IP
 * literal matches only its exact entry.
 */
export function hostMatches(host: string, rawEntry: string): boolean {
	const entry = rawEntry.toLowerCase().replace(/\.+$/, "");
	const h = host.toLowerCase().replace(/\.+$/, "");
	if (psl(h).isIp) return h === entry;
	if (entry.startsWith("*.")) return h.endsWith(entry.slice(1)) && h.length > entry.length - 1;
	return h === entry || h.endsWith(`.${entry}`);
}

export function matchesAny(host: string | undefined, entries: string[]): boolean {
	return host !== undefined && entries.some((entry) => hostMatches(host, entry));
}
