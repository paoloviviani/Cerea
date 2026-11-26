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
	clientId?: string;
}

export type Pairing = { state: "none" } | { state: "ok" } | { state: "other"; address: string };

export function readCreds(file: string): Creds | undefined {
	try {
		const c = JSON.parse(readFileSync(file, "utf8")) as {
			cerea_origin?: unknown;
			issuer?: unknown;
			client_id?: unknown;
		};
		return {
			...(typeof c.cerea_origin === "string" ? { cerea: c.cerea_origin } : {}),
			...(typeof c.issuer === "string" ? { issuer: c.issuer } : {}),
			...(typeof c.client_id === "string" ? { clientId: c.client_id } : {}),
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

/** The server a profile is for: origin and identity provider, and (when known) the exact issuer and client id. */
export interface ServerIdentity {
	origin: string;
	idp: string;
	issuer?: string;
	clientId?: string;
}

const stripSlash = (v: string) => v.replace(/\/+$/, "");

export function pairingFor(creds: Creds | undefined, server: ServerIdentity): Pairing {
	if (!creds) return { state: "none" };
	const cerea = originOf(creds.cerea);
	const issuer = originOf(creds.issuer);
	const other = (): Pairing => ({
		state: "other",
		address: creds.cerea ?? creds.issuer ?? "another server",
	});
	if (!cerea) {
		// An older enrolment recorded no Cerea address. An issuer's origin alone says little (Entra tenants,
		// Google and Keycloak realms share one), so it must be the exact issuer AND the same client id, both
		// known for the profile; anything less is not this profile's.
		if (!creds.issuer || !creds.clientId || !server.issuer || !server.clientId) return other();
		return stripSlash(creds.issuer) === stripSlash(server.issuer) &&
			creds.clientId === server.clientId
			? { state: "ok" }
			: other();
	}
	if (cerea !== server.origin) return other();
	if (issuer && issuer !== server.idp) return other();
	return { state: "ok" };
}
