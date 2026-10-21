/**
 * Where a push may be sent. A push endpoint is chosen by the browser, so by
 * the person, and the server POSTs to it. Real push services are public
 * https hosts, so this is stricter than the shared `urlSafety` guard (which
 * lets 10.0.0.0/8 through for other features): https only, and no private,
 * internal or special-purpose destination, checked on the resolved address at
 * connect time so a hostname cannot be rebound to one.
 */
import dns from "node:dns";
import { isIP } from "node:net";
import { Address4, Address6 } from "ip-address";
import { Agent, fetch as undiciFetch } from "undici";

const BLOCKED_V4 = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"224.0.0.0/4",
	"240.0.0.0/4",
].map((s) => new Address4(s));
const MAPPED = new Address6("::ffff:0:0/96");
const ULA = new Address6("fc00::/7");

function blockedV4(a: Address4): boolean {
	return BLOCKED_V4.some((s) => a.isInSubnet(s));
}

/** True for an address a push must never be sent to. Unparseable counts as blocked. */
export function isInternalAddress(address: string): boolean {
	const bare = address.replace(/^\[|]$/g, "");
	try {
		if (isIP(bare) === 4) return blockedV4(new Address4(bare));
		if (isIP(bare) === 6) {
			const a = new Address6(bare);
			if (a.isInSubnet(MAPPED)) return blockedV4(a.to4());
			return (
				a.correctForm() === "::" ||
				a.isLoopback() ||
				a.isLinkLocal() ||
				a.isInSubnet(ULA) ||
				a.isMulticast()
			);
		}
	} catch {
		return true;
	}
	return true;
}

/** Synchronous check, for saving a subscription and before sending. */
export function isPushEndpointAllowed(endpoint: string): boolean {
	try {
		const url = new URL(endpoint.trim());
		if (url.protocol !== "https:") return false;
		const host = url.hostname.toLowerCase();
		if (host === "localhost" || host.endsWith(".localhost")) return false;
		const bare = host.replace(/^\[|]$/g, "");
		if (isIP(bare)) return !isInternalAddress(bare);
		return true;
	} catch {
		return false;
	}
}

type LookupCallback = (
	err: NodeJS.ErrnoException | null,
	address: string | dns.LookupAddress[],
	family?: number
) => void;

/** Exported for tests: the connect-time lookup that refuses internal results. */
export function guardedLookup(
	hostname: string,
	options: dns.LookupOptions,
	callback: LookupCallback,
	resolve: typeof dns.lookup = dns.lookup
): void {
	(resolve as (h: string, o: dns.LookupOptions, cb: LookupCallback) => void)(
		hostname,
		options,
		(err, address, family) => {
			if (err) return callback(err, "", 4);
			const list = typeof address === "string" ? [address] : address.map((e) => e.address);
			if (list.length === 0 || list.some(isInternalAddress)) {
				return callback(
					new Error(`push endpoint ${hostname} resolves to an internal address`),
					"",
					4
				);
			}
			return callback(null, address, family);
		}
	);
}

const agent = new Agent({
	connect: { lookup: (h, o, cb) => guardedLookup(h, o, cb as LookupCallback) },
});

/** The `fetch` push sends go through. Redirects are never followed. */
export async function pushFetch(url: string, init: RequestInit): Promise<Response> {
	if (!isPushEndpointAllowed(url)) throw new Error("push endpoint not allowed");
	return (await undiciFetch(url, {
		...(init as object),
		dispatcher: agent,
		redirect: "manual",
	} as Parameters<typeof undiciFetch>[1])) as unknown as Response;
}
