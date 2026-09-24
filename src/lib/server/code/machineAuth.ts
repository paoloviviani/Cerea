/**
 * Local JWT validation for the machine link's bearer (spec §3, review C1).
 *
 * Userinfo tells a caller nothing about audience or authorized party, so the
 * old `enroll/machine` endpoint's approach (call userinfo, trust whatever
 * comes back) accepted any access token the issuer ever minted, to any
 * client. This validates the JWT itself, locally, against the issuer's own
 * signing keys: `iss` must be the configured issuer exactly (trailing slash
 * normalized), `aud` must contain the configured machine audience, `azp` (or
 * `client_id`, whichever the token carries) must be the configured machine
 * client, `exp` must be in the future, and the token must not be an ID token
 * wearing an access token's clothes.
 *
 * `CODE_MACHINE_ISSUER` defaults to `OPENID_PROVIDER_URL` so a normal
 * deployment needs no extra configuration, but a test harness can point
 * machine tokens at a mock issuer without touching the browser login's OIDC
 * config at all.
 */

import type { IncomingHttpHeaders } from "node:http";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import type { User } from "$lib/types/User";
import { logger } from "$lib/server/logger";

function normalizeIssuer(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}

function machineIssuer(): string {
	const configured = config.CODE_MACHINE_ISSUER?.trim() || config.OPENID_PROVIDER_URL?.trim();
	if (!configured) {
		throw new Error("No OIDC issuer is configured (CODE_MACHINE_ISSUER or OPENID_PROVIDER_URL).");
	}
	return normalizeIssuer(configured);
}

function machineAudience(): string {
	return config.CODE_MACHINE_AUDIENCE?.trim() || "pystino-api";
}

function machineClientId(): string {
	return config.CODE_MACHINE_CLIENT_ID?.trim() || "opencode-enrollment";
}

/**
 * Where to fetch this issuer's discovery and keys from, when that is not the
 * issuer URL itself.
 *
 * On the Pystino stack the bundled Authelia is published at
 * `https://<origin>/authelia` for browsers and reachable from this container at
 * `OPENID_INTERNAL_URL` (`http://authelia:9091/authelia`). Fetching the public
 * URL from here hairpins through the proxy's TLS listener, which needed a CA
 * bundle that decayed; the browser login already uses the internal URL
 * (`oidcBackchannel.ts` on deploy/rearch), and machine tokens come from the
 * same issuer, so they follow the same rule. Authelia derives its issuer from
 * `X-Forwarded-Proto/Host` and answers nothing on its internal address without
 * them. Only applies when the machine issuer *is* the browser issuer — a
 * separately configured CODE_MACHINE_ISSUER (a test's mock IdP) is fetched
 * where it says.
 */
export function machineBackchannel(
	issuer: string,
	providerUrl: string | undefined,
	internalUrl: string | undefined
): { base: string; headers: Record<string, string> } | null {
	const internal = internalUrl?.trim();
	if (!internal || issuer !== normalizeIssuer(providerUrl ?? "")) return null;
	const url = new URL(issuer);
	return {
		base: normalizeIssuer(internal),
		headers: { "x-forwarded-proto": url.protocol.replace(/:$/, ""), "x-forwarded-host": url.host },
	};
}

interface DiscoveryDoc {
	issuer: string;
	jwks_uri: string;
}

const DISCOVERY_TTL_MS = 10 * 60_000;
const DISCOVERY_TIMEOUT_MS = 5_000;

let cachedForIssuer: string | null = null;
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedAt = 0;

/** The issuer's JWKS, cached per-issuer with a 10-minute TTL — the same
 * discipline `auth.ts`'s `getOIDCClient` applies to its own `Issuer.discover`
 * cache. `createRemoteJWKSet` itself also rate-limits refetches on a cache
 * miss, so a burst of connections during a JWKS rotation cannot hammer the
 * issuer. */
async function jwksFor(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
	const now = Date.now();
	if (cachedJwks && cachedForIssuer === issuer && now - cachedAt < DISCOVERY_TTL_MS) {
		return cachedJwks;
	}
	const backchannel = machineBackchannel(
		issuer,
		config.OPENID_PROVIDER_URL,
		config.OPENID_INTERNAL_URL
	);
	const discoveryUrl = `${backchannel?.base ?? issuer}/.well-known/openid-configuration`;
	// Bounded (R1): a slow or hung IdP must fail the handshake, not hold it open.
	const res = await fetch(discoveryUrl, {
		headers: backchannel?.headers,
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`OIDC discovery at ${discoveryUrl} failed with ${res.status}`);
	}
	const doc = (await res.json()) as DiscoveryDoc;
	if (!doc.jwks_uri) {
		throw new Error(`OIDC discovery at ${discoveryUrl} carried no jwks_uri`);
	}
	// OIDC Discovery §4.3: the document must name the issuer it was fetched for. A
	// mismatch means a misconfigured or impersonated IdP, and its keys must not be trusted.
	if (normalizeIssuer(doc.issuer ?? "") !== issuer) {
		throw new Error(`OIDC discovery at ${discoveryUrl} names issuer ${doc.issuer}, not ${issuer}`);
	}
	// The keys are fetched over the same back-channel: the public jwks_uri moved
	// onto the internal base, with the same forwarded headers.
	const jwksUri =
		backchannel && doc.jwks_uri.startsWith(issuer)
			? backchannel.base + doc.jwks_uri.slice(issuer.length)
			: doc.jwks_uri;
	cachedJwks = createRemoteJWKSet(new URL(jwksUri), {
		timeoutDuration: DISCOVERY_TIMEOUT_MS,
		headers: backchannel?.headers,
	});
	cachedForIssuer = issuer;
	cachedAt = now;
	return cachedJwks;
}

/** `typ` values that mark a token as an ID token rather than an access
 * token — a machine may only present the latter, since the ID token was
 * minted for this deployment's own browser login, not for a device. Most
 * issuers set no `typ` at all on either kind, which is why this is a
 * denylist rather than an allowlist: absent is fine, explicitly-ID-token
 * is not. */
/** Tests only: forget the cached discovery so the next validation fetches it again. */
export function resetMachineDiscoveryCacheForTests(): void {
	cachedJwks = null;
	cachedForIssuer = null;
	cachedAt = 0;
}

function looksLikeIdToken(typ: string | undefined): boolean {
	if (!typ) return false;
	return /id[-_]?token/i.test(typ);
}

export class MachineAuthError extends Error {
	constructor(
		readonly status: 401 | 403,
		message: string
	) {
		super(message);
		this.name = "MachineAuthError";
	}
}

export interface ValidatedMachineToken {
	sub: string;
	iss: string;
	/** Seconds since epoch; the renewal deadline (§3) is `exp + 60s`. */
	exp: number;
}

/** Validate one machine bearer token and return its claims. Thrown errors are
 * always a `MachineAuthError` with the status the caller should answer with
 * (401 for anything about the token itself, 403 reserved for the caller —
 * user mapping — since a token can be perfectly valid and still name nobody
 * this deployment knows). */
export async function validateMachineToken(token: string): Promise<ValidatedMachineToken> {
	const issuer = machineIssuer();
	let header: { typ?: string };
	try {
		header = decodeProtectedHeader(token);
	} catch {
		throw new MachineAuthError(401, "The token is not a valid JWT.");
	}
	if (looksLikeIdToken(header.typ)) {
		throw new MachineAuthError(401, "An ID token was presented where an access token is required.");
	}
	const jwks = await jwksFor(issuer);
	let payload: JWTPayload;
	try {
		const verified = await jwtVerify(token, jwks, {
			issuer,
			audience: machineAudience(),
		});
		payload = verified.payload;
	} catch (err) {
		logger.warn({ err }, "machine link: token verification failed");
		throw new MachineAuthError(
			401,
			"The token is invalid, expired, or not meant for this deployment."
		);
	}
	const azp = (payload.azp as string | undefined) ?? (payload.client_id as string | undefined);
	if (azp !== machineClientId()) {
		throw new MachineAuthError(
			401,
			"The token was not issued to this deployment's machine-enrollment client."
		);
	}
	if (typeof payload.sub !== "string" || !payload.sub) {
		throw new MachineAuthError(401, "The token carries no subject claim.");
	}
	if (typeof payload.exp !== "number") {
		throw new MachineAuthError(401, "The token carries no expiry claim.");
	}
	return { sub: payload.sub, iss: issuer, exp: payload.exp };
}

/** The token's `sub` mapped onto a Cerea user — the same mapping the OIDC
 * login callback applies (`hfUserId`). `null`, not a throw: "no user" is a
 * distinct, callers-choose-the-status outcome (403, per spec §3), not a
 * validation failure. */
export async function userForMachineSub(sub: string): Promise<User | null> {
	return collections.users.findOne({ hfUserId: sub });
}

export interface MachinePrincipal {
	userId: User["_id"];
	sub: string;
	iss: string;
	/** Seconds since epoch; the connection's renewal deadline is `exp + 60s`. */
	exp: number;
	machineId: string;
	machineName: string;
}

export type MachineAuthResult =
	{ ok: true; principal: MachinePrincipal } | { ok: false; status: 401 | 403; message: string };

/** The full pre-upgrade check (spec §3): bearer, `X-Pystino-Machine-Id`,
 * `X-Pystino-Machine-Name`. Rejections here become a plain HTTP 401/403
 * before the WebSocket upgrade completes, never a close code. */
export async function authenticateMachineRequest(
	headers: IncomingHttpHeaders
): Promise<MachineAuthResult> {
	const authorization = headers["authorization"];
	if (!authorization?.startsWith("Bearer ")) {
		return {
			ok: false,
			status: 401,
			message: "Send the enrollment's access token as `Authorization: Bearer <token>`.",
		};
	}
	const machineId = headers["x-pystino-machine-id"];
	if (typeof machineId !== "string" || !machineId.trim()) {
		return { ok: false, status: 401, message: "Missing X-Pystino-Machine-Id." };
	}
	const machineNameHeader = headers["x-pystino-machine-name"];
	const machineName =
		typeof machineNameHeader === "string" && machineNameHeader.trim()
			? machineNameHeader.trim()
			: machineId.trim();

	const token = authorization.slice("Bearer ".length).trim();
	let validated: ValidatedMachineToken;
	try {
		validated = await validateMachineToken(token);
	} catch (err) {
		if (err instanceof MachineAuthError)
			return { ok: false, status: err.status, message: err.message };
		logger.warn({ err }, "machine link: unexpected auth failure");
		return { ok: false, status: 401, message: "Authentication failed." };
	}

	const user = await userForMachineSub(validated.sub);
	if (!user) {
		return {
			ok: false,
			status: 403,
			message: "Sign in to Cerea once before connecting a machine.",
		};
	}

	return {
		ok: true,
		principal: {
			userId: user._id,
			sub: validated.sub,
			iss: validated.iss,
			exp: validated.exp,
			machineId: machineId.trim(),
			machineName,
		},
	};
}

/** Re-validate a renewal (`{"type":"auth","token":"…"}`, §3): same checks,
 * and the same `sub` as the connection's original principal — a renewal
 * cannot hand the connection to a different identity. */
export async function revalidateMachineAuth(
	token: string,
	expectedSub: string
): Promise<ValidatedMachineToken> {
	const validated = await validateMachineToken(token);
	if (validated.sub !== expectedSub) {
		throw new MachineAuthError(401, "A renewal must carry the same subject as the original token.");
	}
	return validated;
}
