/**
 * Which server a galopin pairing belongs to, read from the credential file galopin wrote. A
 * profile uses a pairing only when it is for that profile's own server: the Cerea address and the
 * sign-in provider both match. Anything else is shown as "paired with another server", never used,
 * and never overwritten.
 */
import { readFileSync } from "node:fs";

export interface Creds {
	/** The Cerea address galopin was enrolled with (origin and base path). */
	cerea?: string;
	issuer?: string;
}

export type Pairing = { state: "none" } | { state: "ok" } | { state: "other"; address: string };

export function readCreds(file: string): Creds | undefined {
	try {
		const c = JSON.parse(readFileSync(file, "utf8")) as {
			cerea_origin?: unknown;
			issuer?: unknown;
		};
		return {
			...(typeof c.cerea_origin === "string" ? { cerea: c.cerea_origin } : {}),
			...(typeof c.issuer === "string" ? { issuer: c.issuer } : {}),
		};
	} catch {
		return undefined;
	}
}

const originOf = (v: string | undefined): string | undefined => {
	try {
		return v ? new URL(v).origin : undefined;
	} catch {
		return undefined;
	}
};

/** `server` is the profile's: its origin and its identity provider's origin. */
export function pairingFor(
	creds: Creds | undefined,
	server: { origin: string; idp: string }
): Pairing {
	if (!creds) return { state: "none" };
	const cerea = originOf(creds.cerea);
	// A pairing with no recorded Cerea address (enrolled without one) cannot be shown to be this server's.
	if (!cerea || cerea !== server.origin)
		return { state: "other", address: creds.cerea ?? "another server" };
	const issuer = originOf(creds.issuer);
	if (issuer && issuer !== server.idp)
		return { state: "other", address: creds.cerea ?? "another server" };
	return { state: "ok" };
}
