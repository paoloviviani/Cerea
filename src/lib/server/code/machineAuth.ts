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
 * An issuer whose access tokens are opaque rather than JWTs (GitLab's are
 * Doorkeeper's random strings) has no signature to check. For those, and only
 * at an issuer whose discovery names Doorkeeper's `…/oauth/introspect`, the
 * token is checked at the sibling `GET …/oauth/token/info` with the token
 * itself as the bearer: Doorkeeper answers 401 for an unknown, revoked or
 * expired token, and otherwise names the application it was issued to
 * (`application.uid`, which must be the machine client) and the seconds it
 * has left (which must be some: a token that never expires is refused). The
 * subject is userinfo's `sub`, fetched with the same token, and must agree
 * with the token info's `resource_owner_id`. galopin's GitLab application is
 * public, so introspection proper, which needs a client secret, is not open
 * to it; the gateway does the same check for its `/v1` (Pystino 0.4.2).
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
import { forwardedHeaders } from "$lib/server/oidcBackchannel";
import { me, type GatewayIdentityOptions } from "$lib/server/identity/gatewayIdentity";
import { isGatewayPreset } from "$lib/server/identity/gatewayLogin";

function normalizeIssuer(raw: string): string {
	return raw.trim().replace(/\/+$/, "");
}

/** The issuer a machine bearer is validated against — exported so the device
 * list (`codeDevices.ts`) can flag `enrolledIssuer` drift against the exact
 * same value, rather than a second resolution that could silently diverge. */
export function machineIssuer(): string {
	const configured = config.CODE_MACHINE_ISSUER?.trim() || config.OPENID_PROVIDER_URL?.trim();
	if (!configured) {
		throw new Error("No OIDC issuer is configured (CODE_MACHINE_ISSUER or OPENID_PROVIDER_URL).");
	}
	return normalizeIssuer(configured);
}

function machineAudience(): string {
	return config.CODE_MACHINE_AUDIENCE?.trim() || "pystino-api";
}

/** Exported for the same reason as `machineIssuer`: the feature flags and the
 * pairing dialog's one-liner need this deployment's actual configured client
 * id, not a second guess at `CODE_MACHINE_CLIENT_ID`'s default. */
export function machineClientId(): string {
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
 * (`oidcBackchannel.ts`), and machine tokens come from the
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
	return { base: normalizeIssuer(internal), headers: forwardedHeaders(issuer) };
}

interface DiscoveryDoc {
	issuer: string;
	jwks_uri: string;
	userinfo_endpoint?: string;
	introspection_endpoint?: string;
}

const DISCOVERY_TTL_MS = 10 * 60_000;
const DISCOVERY_TIMEOUT_MS = 5_000;

let cachedForIssuer: string | null = null;
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedDoc: DiscoveryDoc | null = null;
let cachedBackchannel: { base: string; headers: Record<string, string> } | null = null;
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
	cachedDoc = doc;
	cachedBackchannel = backchannel;
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
	cachedDoc = null;
	cachedBackchannel = null;
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
		return validateOpaqueMachineToken(token, issuer);
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

const DOORKEEPER_INTROSPECT = "/oauth/introspect";
const DOORKEEPER_TOKEN_INFO = "/oauth/token/info";

/** An endpoint the issuer published, moved onto the back-channel base the way
 * `jwksFor` moves `jwks_uri`. */
function viaBackchannel(issuer: string, url: string): string {
	return cachedBackchannel && url.startsWith(issuer)
		? cachedBackchannel.base + url.slice(issuer.length)
		: url;
}

async function getWithToken(url: string, token: string): Promise<Response> {
	return fetch(url, {
		headers: {
			...(cachedBackchannel?.headers ?? {}),
			authorization: `Bearer ${token}`,
			accept: "application/json",
		},
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
}

/** An opaque access token, checked with the issuer (see the module comment).
 * Never logs the token or a response body. */
async function validateOpaqueMachineToken(
	token: string,
	issuer: string
): Promise<ValidatedMachineToken> {
	await jwksFor(issuer); // fills the discovery cache
	const introspect = cachedDoc?.introspection_endpoint?.replace(/\/+$/, "") ?? "";
	const userinfo = cachedDoc?.userinfo_endpoint ?? "";
	if (!introspect.endsWith(DOORKEEPER_INTROSPECT) || introspect.includes("?") || !userinfo) {
		throw new MachineAuthError(401, "The token is not a valid JWT.");
	}
	const tokenInfo = viaBackchannel(
		issuer,
		introspect.slice(0, -DOORKEEPER_INTROSPECT.length) + DOORKEEPER_TOKEN_INFO
	);
	const refused = new MachineAuthError(
		401,
		"The token is invalid, expired, or not meant for this deployment."
	);

	let info: Record<string, unknown>;
	try {
		const res = await getWithToken(tokenInfo, token);
		if (!res.ok) {
			logger.warn({ status: res.status }, "machine link: token info refused an opaque token");
			throw refused;
		}
		info = (await res.json()) as Record<string, unknown>;
	} catch (err) {
		if (err instanceof MachineAuthError) throw err;
		logger.warn({ err }, "machine link: token info unreachable");
		throw refused;
	}

	const application = info.application as { uid?: unknown } | undefined;
	if (application?.uid !== machineClientId()) {
		throw new MachineAuthError(
			401,
			"The token was not issued to this deployment's machine-enrollment client."
		);
	}
	// GitLab adds `expires_in_seconds`; Doorkeeper's own is `expires_in`. Both
	// are seconds left, null for a token that never expires.
	const left = info.expires_in_seconds ?? info.expires_in;
	if (typeof left !== "number" || left <= 0) {
		throw new MachineAuthError(401, "The token carries no expiry claim.");
	}

	let sub: unknown;
	try {
		const res = await getWithToken(viaBackchannel(issuer, userinfo), token);
		if (!res.ok) throw refused;
		sub = ((await res.json()) as { sub?: unknown }).sub;
	} catch (err) {
		if (err instanceof MachineAuthError) throw err;
		logger.warn({ err }, "machine link: userinfo unreachable for an opaque token");
		throw refused;
	}
	if (typeof sub !== "string" || !sub) {
		throw new MachineAuthError(401, "The token carries no subject claim.");
	}
	const owner = info.resource_owner_id;
	if (owner !== undefined && owner !== null && String(owner) !== sub) {
		throw refused;
	}
	return { sub, iss: issuer, exp: Math.floor(Date.now() / 1000) + Math.floor(left) };
}

/** The token's `sub` mapped onto a Cerea user on the generic (gateway-less)
 * preset — the same mapping the OIDC login callback applied there before
 * ADR 0093. `null`, not a throw: "no user" is a distinct,
 * callers-choose-the-status outcome (403, per spec §3), not a validation
 * failure. */
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
	| { ok: true; principal: MachinePrincipal; token: string }
	| { ok: false; status: 401 | 403; message: string };

/** What the gateway says this person holds, for the machine kinds Cerea serves (Pystino's
 * `code_agents` and `local_connectors` capabilities). Absent on a resolution means no
 * restriction: standalone (no gateway) or a gateway that predates capabilities. */
export interface MachineCapabilities {
	codeAgents: boolean;
	localConnectors: boolean;
	/** The gateway reports neither capability because it has no chat configured
	 * (`GATEWAY_CHAT__ENABLED` false): a misconfiguration, not a refusal of the person. */
	chatUnconfigured: boolean;
}

/** Why this person's machine of `mode` may not connect, or null when it may. Agent machines
 * need `code_agents`, connectors machines `local_connectors`; the mode is only known at the
 * machine's hello, so this is asked there and again on every revalidation. */
export function machineCapabilityRefusal(
	capabilities: MachineCapabilities | undefined,
	mode: "agent" | "connectors"
): string | null {
	if (!capabilities) return null;
	if (capabilities.chatUnconfigured) {
		return "this gateway is not configured for the chat (GATEWAY_CHAT__ENABLED is off)";
	}
	if (mode === "connectors") {
		return capabilities.localConnectors
			? null
			: "local connectors are not enabled for this account's groups; reconnect when they say so";
	}
	return capabilities.codeAgents
		? null
		: "coding agents are not available for this account; reconnect when they say so";
}

function capabilitiesFromMe(
	raw: import("$lib/server/identity/gatewayIdentity").GatewayMe["capabilities"]
): MachineCapabilities | undefined {
	if (!raw) return undefined;
	return {
		codeAgents: raw.code_agents === true,
		localConnectors: raw.local_connectors === undefined || raw.local_connectors === true,
		chatUnconfigured: raw.code_agents === null && raw.local_connectors === null,
	};
}

export type MachineUserResolution =
	| {
			ok: true;
			user: User;
			sessionsValidAfter: string | null;
			capabilities?: MachineCapabilities;
	  }
	// `refused: true` is a real answer from the gateway (401/403): the
	// account is refused, and a device row may be revoked over it. `refused:
	// false` is a network error or 5xx that outlasted the bounded fail-open
	// below (or a brand-new connection with nothing cached at all) — an
	// outage, not a refusal, so a live connection is closed but never
	// revoked over one.
	| {
			ok: false;
			status: 401 | 403;
			message: string;
			refused: boolean;
			/** The gateway's own error code, when it sent one. ADR 0095:
			 * `outside_access_groups` is the join gate refusing an
			 * authenticated caller; ADR 0096: `agents_not_allowed` is the
			 * code_agents gate refusing a machine-client token. Both are a
			 * loss regaining the group (or the flag) reverses, so a live
			 * link is closed (4404), never revoked, over either — and a
			 * refused upgrade answers a plain 403 that the machine retries. */
			code?: string;
	  };

export interface ResolveMachineUserOptions extends GatewayIdentityOptions {
	now?: () => number;
}

/** `GET /v1/me` answers per `(sub, exp)`, cached for 60s — the same call a
 * fresh connect and the periodic revalidation tick (`machines.ts`) both make,
 * so a busy reconnect storm from one machine costs one gateway call, not
 * one per attempt. */
const meCache = new Map<string, { at: number; result: MachineUserResolution }>();
const ME_CACHE_TTL_MS = 60_000;

/** The last known-good resolution per `sub` (not per `(sub, exp)` — a token
 * renewal must not reset this), for the bounded fail-open below. */
const lastGoodBySub = new Map<
	string,
	{ at: number; resolution: Extract<MachineUserResolution, { ok: true }> }
>();
const FAIL_OPEN_GRACE_MS = 5 * 60_000;

/** Forget every cached answer — tests only, so a fresh gateway state is
 * actually observed rather than a stale cache entry from an earlier case. */
export function resetMachineUserCacheForTests(): void {
	meCache.clear();
	lastGoodBySub.clear();
}

/**
 * The bearer's `sub` mapped onto a Cerea user (ADR 0093 §4.7). On a gateway
 * preset this resolves through the gateway rather than by `hfUserId`: `GET
 * /v1/me` with the machine's own token, valid there (audience `pystino-api`,
 * `azp` in `ACCEPTED_CLIENTS`), yielding the gateway id and so
 * `gatewayUserId`. **A 401/403 for a locally valid, unexpired token means
 * the account is refused** — the token's signature and expiry say nothing
 * about whether the account behind it is still active or still exists.
 *
 * A network error or 5xx is not a refusal: it fails open for at most five
 * minutes after the last good answer *for that subject* (mirroring §4.4's
 * bounded fail-open on the browser session check exactly) — keyed by `sub`,
 * not `(sub, exp)`, since a token renewal must not reset the clock. Past
 * that bound, or with no good answer ever recorded (a brand-new
 * connection), it is refused — but marked `refused: false`, so a caller
 * revalidating an already-live connection knows to close it without
 * revoking the device: an outage is not the same fact as the gateway
 * saying no.
 */
export async function resolveMachineUser(
	sub: string,
	exp: number,
	token: string,
	options?: ResolveMachineUserOptions
): Promise<MachineUserResolution> {
	if (!isGatewayPreset()) {
		const user = await userForMachineSub(sub);
		return user
			? { ok: true, user, sessionsValidAfter: null }
			: {
					ok: false,
					status: 403,
					message: "Sign in to Cerea once before connecting a machine.",
					refused: true,
				};
	}

	const now = (options?.now ?? Date.now)();
	const cacheKey = `${sub}:${exp}`;
	const hit = meCache.get(cacheKey);
	if (hit && now - hit.at < ME_CACHE_TTL_MS) return hit.result;

	const result = await me(token, options ?? { baseUrl: config.OPENAI_BASE_URL ?? "" });
	let resolution: MachineUserResolution;
	if (!result.ok) {
		if (result.refused) {
			// A real refusal is authoritative: it must not be masked by a stale
			// good answer during a later outage.
			lastGoodBySub.delete(sub);
			resolution = {
				ok: false,
				status: result.status as 401 | 403,
				message: result.message,
				refused: true,
				code: result.code,
			};
		} else {
			const lastGood = lastGoodBySub.get(sub);
			if (lastGood && now - lastGood.at < FAIL_OPEN_GRACE_MS) {
				resolution = lastGood.resolution;
			} else {
				logger.warn(
					{ status: result.status },
					"machine link: gateway unreachable resolving user, past the fail-open bound"
				);
				resolution = {
					ok: false,
					status: 401,
					message: "The service is not available right now. Try again in a minute.",
					refused: false,
				};
			}
		}
	} else {
		const user = await collections.users.findOne({ gatewayUserId: result.value.id });
		if (user) {
			resolution = {
				ok: true,
				user,
				sessionsValidAfter: result.value.sessions_valid_after,
				capabilities: capabilitiesFromMe(result.value.capabilities),
			};
			lastGoodBySub.set(sub, { at: now, resolution });
		} else {
			resolution = {
				ok: false,
				status: 403,
				message: "Sign in to Cerea once before connecting a machine.",
				refused: true,
			};
		}
	}
	meCache.set(cacheKey, { at: now, result: resolution });
	return resolution;
}

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

	const resolution = await resolveMachineUser(validated.sub, validated.exp, token);
	if (!resolution.ok) {
		if (resolution.refused && resolution.status === 401 && isGatewayPreset()) {
			// The gateway refuses a locally valid, unexpired token: revoke this
			// device row (§4.7) so a fresh `galopin enroll` is required even
			// after the account is re-enabled. Keyed by `sub` (not `userId`,
			// unknown here) — the same OIDC subject `onHello` records on every
			// connect. A device that has never connected has no row to revoke,
			// which is fine: there is nothing to leave enrolled.
			await collections.codeDevices
				.updateOne(
					{ sub: validated.sub, machineId: machineId.trim() },
					{
						$set: {
							status: "revoked",
							revokedAt: new Date(),
							revokedReason: "account_disabled",
							updatedAt: new Date(),
						},
					}
				)
				.catch((err) =>
					logger.warn({ err, sub: validated.sub }, "machine link: failed to revoke device row")
				);
		}
		return { ok: false, status: resolution.status, message: resolution.message };
	}

	return {
		ok: true,
		principal: {
			userId: resolution.user._id,
			sub: validated.sub,
			iss: validated.iss,
			exp: validated.exp,
			machineId: machineId.trim(),
			machineName,
		},
		token,
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
