/**
 * Choosing the Cerea server. The address is checked before anything is stored: https only
 * (loopback may use http), and the server must answer like a Cerea deployment, with the public
 * facts galopin's own enroll reads (`<address>/galopin/enroll.json`), so a random site is refused.
 * Its name and logo come from its web app manifest.
 */

export interface ServerInfo {
	/** The sign-in provider's origin (the issuer in enroll.json). */
	idp: string;
	/** The address as stored: scheme, host and base path, no trailing slash. */
	address: string;
	origin: string;
	name: string;
	/** An absolute https (or loopback http) URL of the server's icon, shown beside the name. */
	icon?: string;
}

export class ServerError extends Error {}

export function isLoopbackHost(host: string): boolean {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

/** Turns what the user typed into a canonical address, or throws a plain-language error. */
export function normalizeAddress(input: string): string {
	let text = input.trim();
	if (!text) throw new ServerError("Enter the address of your Cerea.");
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
		const host = text.split(/[/:?#]/)[0];
		text = `${isLoopbackHost(host) ? "http" : "https"}://${text}`;
	}
	let u: URL;
	try {
		u = new URL(text);
	} catch {
		throw new ServerError("That is not an address.");
	}
	if (u.username || u.password)
		throw new ServerError("The address cannot contain a user name or password.");
	if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
		throw new ServerError(
			"The address must start with https:// (http:// only works for this computer)."
		);
	}
	const path = u.pathname.replace(/\/+$/, "");
	return `${u.origin}${path}`;
}

type Fetch = (
	url: string,
	init: { signal: AbortSignal; redirect: "manual" }
) => Promise<{
	status: number;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}>;

async function getJson(fetchFn: Fetch, url: string, maxBytes: number): Promise<unknown> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), 8000);
	try {
		// A redirect is never followed: a server that moves has to be addressed where it lives.
		const res = await fetchFn(url, { signal: ac.signal, redirect: "manual" });
		if (res.status !== 200) throw new ServerError(`status ${res.status}`);
		const body = await res.text();
		if (body.length > maxBytes) throw new ServerError("too large");
		return JSON.parse(body);
	} finally {
		clearTimeout(timer);
	}
}

/** Asks the server who it is. Throws a ServerError saying why it is not a Cerea. */
export async function probeServer(address: string, fetchFn: Fetch): Promise<ServerInfo> {
	const norm = normalizeAddress(address);
	const origin = new URL(norm).origin;
	let facts: unknown;
	try {
		facts = await getJson(fetchFn, `${norm}/galopin/enroll.json`, 64 * 1024);
	} catch (e) {
		const why = e instanceof ServerError ? ` (${e.message})` : "";
		throw new ServerError(
			`${new URL(norm).host} did not answer like a Cerea${why}. Check the address, including a path such as /chat if your Cerea has one.`
		);
	}
	const f = facts as Record<string, unknown> | null;
	if (
		!f ||
		typeof f !== "object" ||
		typeof f.issuer !== "string" ||
		typeof f.clientId !== "string"
	) {
		throw new ServerError(
			`${new URL(norm).host} is not a Cerea (it did not give its sign-in settings).`
		);
	}
	let idp: string;
	try {
		const iss = new URL(f.issuer);
		if (iss.protocol !== "https:" && !(iss.protocol === "http:" && isLoopbackHost(iss.hostname)))
			throw new Error("insecure");
		idp = iss.origin;
	} catch {
		throw new ServerError(
			`${new URL(norm).host} gave a sign-in address that is not secure, so it cannot be used.`
		);
	}
	let name = new URL(norm).host;
	let icon: string | undefined;
	try {
		const m = (await getJson(fetchFn, `${norm}/manifest.webmanifest`, 64 * 1024)) as Record<
			string,
			unknown
		>;
		if (typeof m.name === "string" && m.name.trim()) name = m.name.trim().slice(0, 80);
		const icons = Array.isArray(m.icons) ? (m.icons as { src?: unknown }[]) : [];
		const src = icons.find((i) => typeof i?.src === "string")?.src;
		if (typeof src === "string") {
			const abs = new URL(src, `${norm}/`);
			// Only an icon from the server itself is shown.
			if (abs.origin === origin) icon = abs.href;
		}
	} catch {
		// the name and logo are a courtesy: the host name stands in
	}
	return { address: norm, origin, idp, name, ...(icon ? { icon } : {}) };
}
