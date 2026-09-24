import {
	Issuer,
	type BaseClient,
	type UserinfoResponse,
	type TokenSet,
	custom,
	generators,
} from "openid-client";
import { fillLogoutTemplate } from "$lib/server/oidcLogout";
import type { RequestEvent } from "@sveltejs/kit";
import { addHours, addWeeks, differenceInMinutes, subMinutes } from "date-fns";
import { config } from "$lib/server/config";
import { discoverViaInternal, withForwardedHeaders } from "$lib/server/oidcBackchannel";
import { forgetGatewaySession, gatewaySessionCheck } from "$lib/server/gatewaySession";
import { sha256 } from "$lib/utils/sha256";
import { z } from "zod";
import { dev } from "$app/environment";
import { redirect, type Cookies } from "@sveltejs/kit";
import { collections } from "$lib/server/database";
import JSON5 from "json5";
import { logger } from "$lib/server/logger";
import { adminTokenManager } from "./adminToken";
import type { User } from "$lib/types/User";
import type { Session } from "$lib/types/Session";
import { base } from "$app/paths";
import { acquireLock, isDBLocked, releaseLock } from "$lib/migrations/lock";
import { Semaphores } from "$lib/types/Semaphore";

export interface OIDCSettings {
	redirectURI: string;
}

export interface OIDCUserInfo {
	token: TokenSet;
	userData: UserinfoResponse;
}

const stringWithDefault = (value: string) =>
	z
		.string()
		.default(value)
		.transform((el) => (el ? el : value));

export const OIDConfig = z
	.object({
		CLIENT_ID: stringWithDefault(config.OPENID_CLIENT_ID),
		CLIENT_SECRET: stringWithDefault(config.OPENID_CLIENT_SECRET),
		PROVIDER_URL: stringWithDefault(config.OPENID_PROVIDER_URL),
		// Where this server reaches the issuer when that is not PROVIDER_URL
		// (the bundled Authelia on the compose network). Empty: use PROVIDER_URL.
		INTERNAL_URL: stringWithDefault(config.OPENID_INTERNAL_URL),
		// The provider's logout page when it publishes no end_session_endpoint
		// (the bundled Authelia); `{redirect}` is where to land. See oidcLogout.ts.
		LOGOUT_URL: stringWithDefault(config.OPENID_LOGOUT_URL),
		SCOPES: stringWithDefault(config.OPENID_SCOPES),
		NAME_CLAIM: stringWithDefault(config.OPENID_NAME_CLAIM).refine(
			(el) => !["preferred_username", "email", "picture", "sub"].includes(el),
			{ message: "nameClaim cannot be one of the restricted keys." }
		),
		TOLERANCE: stringWithDefault(config.OPENID_TOLERANCE),
		RESOURCE: stringWithDefault(config.OPENID_RESOURCE),
		ID_TOKEN_SIGNED_RESPONSE_ALG: z.string().optional(),
	})
	.parse(JSON5.parse(config.OPENID_CONFIG || "{}"));

export const loginEnabled = !!OIDConfig.CLIENT_ID;

export const secure = z
	.boolean()
	.default(!(dev || config.ALLOW_INSECURE_COOKIES === "true"))
	.parse(config.COOKIE_SECURE === "" ? undefined : config.COOKIE_SECURE === "true");

// `none` is only needed when the session cookie must ride along on a
// cross-site request — the one case here is the app being embedded in
// someone else's iframe (the HuggingFace Space heritage this fork carries:
// HF Spaces frame the chat cross-origin, and a `lax` cookie is dropped on
// that third-party navigation). `ALLOW_IFRAME=true` is that deployment's own
// signal that it still needs the iframe, so only that case keeps the old
// `none` default; every other deployment defaults to `lax`, which also
// closes a CSRF gap a cross-site POST could otherwise ride a `none` cookie
// into (see the Origin/Content-Type checks in hooks/handle.ts).
export const sameSite = z
	.enum(["lax", "none", "strict"])
	.default(
		config.ALLOW_IFRAME === "true" && secure && !dev && config.ALLOW_INSECURE_COOKIES !== "true"
			? "none"
			: "lax"
	)
	.parse(config.COOKIE_SAMESITE === "" ? undefined : config.COOKIE_SAMESITE);

export function sanitizeReturnPath(path: string | undefined | null): string | undefined {
	if (!path) {
		return undefined;
	}
	if (path.startsWith("//")) {
		return undefined;
	}
	if (!path.startsWith("/")) {
		return undefined;
	}
	return path;
}

/**
 * One-shot guard used when restarting the OAuth flow after a callback that was started
 * in another browser (e.g. "Open in Safari" from an in-app browser). Prevents redirect loops.
 */
const loginRetryCookieName = "hfChat-loginRetry";

export function hasLoginRetryCookie(cookies: Cookies): boolean {
	return cookies.get(loginRetryCookieName) === "1";
}

export function setLoginRetryCookie(cookies: Cookies) {
	cookies.set(loginRetryCookieName, "1", {
		path: "/",
		// `strict` would keep this cookie from being sent on the cross-site IdP -> callback
		// navigation, which is exactly where the loop guard must be observable
		sameSite: sameSite === "strict" ? "lax" : sameSite,
		secure,
		httpOnly: true,
		maxAge: 5 * 60,
	});
}

export function clearLoginRetryCookie(cookies: Cookies) {
	cookies.delete(loginRetryCookieName, { path: "/" });
}

export function refreshSessionCookie(cookies: Cookies, sessionId: string) {
	cookies.set(config.COOKIE_NAME, sessionId, {
		path: "/",
		// So that it works inside the space's iframe
		sameSite,
		secure,
		httpOnly: true,
		expires: addWeeks(new Date(), 2),
	});
}

export async function findUser(
	sessionId: string,
	coupledCookieHash: string | undefined,
	url: URL
): Promise<{
	user: User | null;
	invalidateSession: boolean;
	oauth?: Session["oauth"];
}> {
	const session = await collections.sessions.findOne({ sessionId });

	if (!session) {
		return { user: null, invalidateSession: false };
	}

	if (coupledCookieHash && session.coupledCookieHash !== coupledCookieHash) {
		return { user: null, invalidateSession: true };
	}

	// Check if OAuth token needs refresh
	if (session.oauth?.token && session.oauth.refreshToken) {
		// If token expires in less than 5 minutes, refresh it
		if (differenceInMinutes(session.oauth.token.expiresAt, new Date()) < 5) {
			const lockKey = `${Semaphores.OAUTH_TOKEN_REFRESH}:${sessionId}`;

			// Acquire lock for token refresh
			const lockId = await acquireLock(lockKey);
			if (lockId) {
				try {
					// Attempt to refresh the token
					const newTokenSet = await refreshOAuthToken(
						{ redirectURI: `${config.PUBLIC_ORIGIN}${base}/login/callback` },
						session.oauth.refreshToken,
						url
					);

					if (!newTokenSet || !newTokenSet.access_token) {
						// Token refresh failed, invalidate session
						return { user: null, invalidateSession: true };
					}

					// Update session with new token information
					const updatedOAuth = tokenSetToSessionOauth(newTokenSet);

					if (!updatedOAuth) {
						// Token refresh failed, invalidate session
						return { user: null, invalidateSession: true };
					}

					await collections.sessions.updateOne(
						{ sessionId },
						{
							$set: {
								oauth: updatedOAuth,
								updatedAt: new Date(),
							},
						}
					);

					session.oauth = updatedOAuth;
				} catch (err) {
					logger.error(err, "Error during token refresh:");
					return { user: null, invalidateSession: true };
				} finally {
					await releaseLock(lockKey, lockId);
				}
			} else if (new Date() > session.oauth.token.expiresAt) {
				// If the token has expired, we need to wait for the token refresh to complete
				let attempts = 0;
				do {
					await new Promise((resolve) => setTimeout(resolve, 200));
					attempts++;
					if (attempts > 20) {
						return { user: null, invalidateSession: true };
					}
				} while (await isDBLocked(lockKey));

				const updatedSession = await collections.sessions.findOne({ sessionId });
				if (!updatedSession || updatedSession.oauth?.token === session.oauth.token) {
					return { user: null, invalidateSession: true };
				}

				session.oauth = updatedSession.oauth;
			}
		}
	} else if (session.oauth?.token && !session.oauth.refreshToken) {
		if (new Date() > session.oauth.token.expiresAt) {
			return { user: null, invalidateSession: true };
		}
	}

	return {
		user: await collections.users.findOne({ _id: session.userId }),
		invalidateSession: false,
		oauth: session.oauth,
	};
}
export const authCondition = (locals: App.Locals) => {
	if (!locals.user && !locals.sessionId) {
		throw new Error("User or sessionId is required");
	}

	return locals.user
		? { userId: locals.user._id }
		: { sessionId: locals.sessionId, userId: { $exists: false } };
};

export function tokenSetToSessionOauth(tokenSet: TokenSet): Session["oauth"] {
	if (!tokenSet.access_token) {
		return undefined;
	}

	return {
		token: {
			value: tokenSet.access_token,
			expiresAt: tokenSet.expires_at
				? subMinutes(new Date(tokenSet.expires_at * 1000), 1)
				: addWeeks(new Date(), 2),
		},
		refreshToken: tokenSet.refresh_token || undefined,
		// Kept for `id_token_hint` on logout, and for nothing else.
		idToken: tokenSet.id_token || undefined,
	};
}

/**
 * Generates a CSRF token using the user sessionId. Note that we don't need a secret because sessionId is enough.
 */
async function generateCsrfToken(
	sessionId: string,
	redirectUrl: string,
	next?: string
): Promise<string> {
	const sanitizedNext = sanitizeReturnPath(next);
	const data = {
		expiration: addHours(new Date(), 1).getTime(),
		redirectUrl,
		...(sanitizedNext ? { next: sanitizedNext } : {}),
	} as {
		expiration: number;
		redirectUrl: string;
		next?: string;
	};

	return Buffer.from(
		JSON.stringify({
			data,
			signature: await sha256(JSON.stringify(data) + "##" + sessionId),
		})
	).toString("base64");
}

let lastIssuer: Issuer<BaseClient> | null = null;
let lastIssuerFetchedAt: Date | null = null;
async function getOIDCClient(settings: OIDCSettings, url: URL): Promise<BaseClient> {
	if (
		lastIssuer &&
		lastIssuerFetchedAt &&
		differenceInMinutes(new Date(), lastIssuerFetchedAt) >= 10
	) {
		lastIssuer = null;
		lastIssuerFetchedAt = null;
	}
	if (!lastIssuer) {
		if (OIDConfig.INTERNAL_URL) {
			// Back-channel over the compose network (oidcBackchannel.ts): no
			// hairpin through the proxy, so no CA bundle to keep in step.
			const metadata = await discoverViaInternal(OIDConfig.PROVIDER_URL, OIDConfig.INTERNAL_URL);
			lastIssuer = new Issuer(metadata);
			// JWKS is fetched by the issuer, so it needs the headers too.
			lastIssuer[custom.http_options] = withForwardedHeaders(OIDConfig.PROVIDER_URL);
		} else {
			lastIssuer = await Issuer.discover(OIDConfig.PROVIDER_URL);
		}
		lastIssuerFetchedAt = new Date();
	}

	const issuer = lastIssuer;

	const client_config: ConstructorParameters<typeof issuer.Client>[0] = {
		client_id: OIDConfig.CLIENT_ID,
		client_secret: OIDConfig.CLIENT_SECRET,
		redirect_uris: [settings.redirectURI],
		response_types: ["code"],
		[custom.clock_tolerance]: OIDConfig.TOLERANCE || undefined,
		id_token_signed_response_alg: OIDConfig.ID_TOKEN_SIGNED_RESPONSE_ALG || undefined,
	};

	if (OIDConfig.CLIENT_ID === "__CIMD__") {
		// See https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/
		client_config.client_id = new URL(
			`${base}/.well-known/oauth-cimd`,
			config.PUBLIC_ORIGIN || url.origin
		).toString();
	}

	const alg_supported = issuer.metadata["id_token_signing_alg_values_supported"];

	if (Array.isArray(alg_supported)) {
		// Prefer RS256, not `alg_supported[0]`.
		//
		// `id_token_signing_alg_values_supported` is a *set* in the discovery
		// spec — its order carries no meaning, and no provider promises to sign
		// with whatever happens to be printed first. Taking element zero reads a
		// preference into an array that has none, and then demands an algorithm
		// the provider advertises but does not use.
		//
		// Keycloak is the case that shows it. It lists thirteen algorithms with
		// PS384 first and RS256 at index seven, and signs with RS256 — so the
		// login completes, the provider issues a correct token, and the callback
		// fails with `unexpected JWT alg received, expected PS384, got: RS256`.
		// Nothing in that message suggests the client chose the algorithm
		// arbitrarily.
		//
		// RS256 is the right default because OIDC Core requires every provider
		// to support it for the authorization code flow, so preferring it can
		// only ever pick something the provider really signs with.
		// `ID_TOKEN_SIGNED_RESPONSE_ALG` still overrides, for a provider that
		// genuinely uses something else.
		client_config.id_token_signed_response_alg ??= alg_supported.includes("RS256")
			? "RS256"
			: alg_supported[0];
	}

	const client = new issuer.Client(client_config);
	if (OIDConfig.INTERNAL_URL) {
		// Token and userinfo requests are the client's: same headers, so the
		// IdP mints tokens whose `iss` is the public issuer.
		client[custom.http_options] = withForwardedHeaders(OIDConfig.PROVIDER_URL);
	}
	return client;
}

export async function getOIDCAuthorizationUrl(
	settings: OIDCSettings,
	params: { sessionId: string; next?: string; url: URL; cookies: Cookies }
): Promise<string> {
	const client = await getOIDCClient(settings, params.url);
	const csrfToken = await generateCsrfToken(
		params.sessionId,
		settings.redirectURI,
		sanitizeReturnPath(params.next)
	);

	const codeVerifier = generators.codeVerifier();
	const codeChallenge = generators.codeChallenge(codeVerifier);

	params.cookies.set("hfChat-codeVerifier", codeVerifier, {
		path: "/",
		sameSite,
		secure,
		httpOnly: true,
		expires: addHours(new Date(), 1),
	});

	return client.authorizationUrl({
		code_challenge_method: "S256",
		code_challenge: codeChallenge,
		scope: OIDConfig.SCOPES,
		state: csrfToken,
		resource: OIDConfig.RESOURCE || undefined,
	});
}

/**
 * Where to send the browser to end the session at the provider, or `null` when
 * the provider advertises no such endpoint.
 *
 * This is the half of signing out that the local cookie cannot do. Clearing our
 * own session while the directory's stays live means the next navigation
 * re-authenticates silently — the person appears never to have signed out.
 *
 * `null` rather than a throw for a provider without an `end_session_endpoint`:
 * ending the local session is still a correct, if partial, sign-out, and
 * refusing to do it because the provider cannot do more would be worse.
 */
export async function getOIDCLogoutUrl(
	settings: OIDCSettings,
	params: { url: URL; idToken?: string; postLogoutRedirectUri: string }
): Promise<string | null> {
	if (!loginEnabled) return null;
	// Configured first, like the gateway's per-provider override: it is how a
	// provider without an end_session_endpoint (Authelia) is signed out of at
	// all, and it needs no discovery round trip.
	if (OIDConfig.LOGOUT_URL) {
		return fillLogoutTemplate(OIDConfig.LOGOUT_URL, params.postLogoutRedirectUri);
	}
	try {
		const client = await getOIDCClient(settings, params.url);
		if (!client.issuer.metadata.end_session_endpoint) return null;
		return client.endSessionUrl({
			...(params.idToken ? { id_token_hint: params.idToken } : {}),
			post_logout_redirect_uri: params.postLogoutRedirectUri,
		});
	} catch (err) {
		// Discovery is a network call, and a logout must not fail on it: the
		// local session is already gone by the time this is asked.
		logger.warn({ err }, "oidc_logout_url_unavailable: signing out locally only");
		return null;
	}
}

export async function getOIDCUserData(
	settings: OIDCSettings,
	code: string,
	codeVerifier: string,
	iss: string | undefined,
	url: URL
): Promise<OIDCUserInfo> {
	const client = await getOIDCClient(settings, url);
	const token = await client.callback(
		settings.redirectURI,
		{
			code,
			iss,
		},
		{ code_verifier: codeVerifier }
	);
	const userData = await client.userinfo(token);

	return { token, userData };
}

/**
 * Validates a bearer access token issued by this deployment's provider and
 * returns its claims — the userinfo-only path, for a caller that already
 * holds a token and has no browser to run an exchange.
 *
 * The caller is the machine pairing endpoint: the enroll CLI presents the
 * token the enrollment flow minted (client `opencode-enrollment`, a secret-
 * less public client) and the chat maps `sub` onto a user row. The provider
 * accepts any valid bearer from its own issuer at userinfo, whatever client
 * minted it — verified live against Authelia 4.39.22 (the bundled IdP), and
 * it is how userinfo is specified to work; client authentication is a token
 * *endpoint* concern.
 */
export async function getOIDCUserFromToken(
	settings: OIDCSettings,
	token: string,
	url: URL
): Promise<UserinfoResponse> {
	const client = await getOIDCClient(settings, url);
	return client.userinfo(token);
}

/**
 * Refreshes an OAuth token using the refresh token
 */
export async function refreshOAuthToken(
	settings: OIDCSettings,
	refreshToken: string,
	url: URL
): Promise<TokenSet | null> {
	const client = await getOIDCClient(settings, url);
	const tokenSet = await client.refresh(refreshToken);
	return tokenSet;
}

export async function validateAndParseCsrfToken(
	token: string,
	sessionId: string
): Promise<{
	/** This is the redirect url that was passed to the OIDC provider */
	redirectUrl: string;
	/** Relative path (within this app) to return to after login */
	next?: string;
} | null> {
	try {
		const { data, signature } = z
			.object({
				data: z.object({
					expiration: z.number().int(),
					redirectUrl: z.string().url(),
					next: z.string().optional(),
				}),
				signature: z.string().length(64),
			})
			.parse(JSON.parse(token));

		const reconstructSign = await sha256(JSON.stringify(data) + "##" + sessionId);

		if (data.expiration > Date.now() && signature === reconstructSign) {
			return { redirectUrl: data.redirectUrl, next: sanitizeReturnPath(data.next) };
		}
	} catch (e) {
		logger.error(e, "Error validating and parsing CSRF token");
	}
	return null;
}

type CookieRecord = Cookies;

export async function getCoupledCookieHash(cookie: CookieRecord): Promise<string | undefined> {
	if (!config.COUPLE_SESSION_WITH_COOKIE_NAME) {
		return undefined;
	}

	const cookieValue = cookie.get(config.COUPLE_SESSION_WITH_COOKIE_NAME);

	if (!cookieValue) {
		return "no-cookie";
	}

	return await sha256(cookieValue);
}

export async function authenticateRequest(
	cookie: CookieRecord,
	url: URL
): Promise<App.Locals & { secretSessionId: string }> {
	const token = cookie.get(config.COOKIE_NAME);

	let secretSessionId: string | null = null;
	let sessionId: string | null = null;

	if (token) {
		secretSessionId = token;
		sessionId = await sha256(token);

		const result = await findUser(sessionId, await getCoupledCookieHash(cookie), url);

		// The gateway decides admin and whether the account is still active
		// (gatewaySession.ts): a 401 on the session's own token ends it here,
		// which is how a directory deprovisioning reaches the chat within a
		// minute. Null — no gateway, a shared key, or the gateway unreachable —
		// changes nothing.
		const gateway =
			result.user && result.oauth?.token?.value
				? await gatewaySessionCheck(sessionId, result.oauth.token.value)
				: null;
		if (gateway && !gateway.valid) {
			forgetGatewaySession(sessionId);
			await collections.sessions.deleteOne({ sessionId });
			result.user = null;
			result.invalidateSession = true;
		}

		if (result.invalidateSession) {
			secretSessionId = crypto.randomUUID();
			sessionId = await sha256(secretSessionId);

			if (await collections.sessions.findOne({ sessionId })) {
				throw new Error("Session ID collision");
			}
		}

		return {
			user: result.user ?? undefined,
			token: result.oauth?.token?.value,
			sessionId,
			secretSessionId,
			isAdmin: (gateway?.valid === true && gateway.isAdmin) || adminTokenManager.isAdmin(sessionId),
		};
	}

	// Generate new session if none exists
	secretSessionId = crypto.randomUUID();
	sessionId = await sha256(secretSessionId);

	if (await collections.sessions.findOne({ sessionId })) {
		throw new Error("Session ID collision");
	}

	return { user: undefined, sessionId, secretSessionId, isAdmin: false };
}

export async function triggerOauthFlow({ url, locals, cookies }: RequestEvent): Promise<Response> {
	// const referer = request.headers.get("referer");
	// let redirectURI = `${(referer ? new URL(referer) : url).origin}${base}/login/callback`;
	let redirectURI = `${url.origin}${base}/login/callback`;

	// TODO: Handle errors if provider is not responding

	if (url.searchParams.has("callback")) {
		const callback = url.searchParams.get("callback") || redirectURI;
		if (config.ALTERNATIVE_REDIRECT_URLS.includes(callback)) {
			redirectURI = callback;
		}
	}

	// Preserve a safe in-app return path after login.
	// Priority: explicit ?next=... (must be an absolute path), else the current path (when auto-login kicks in).
	let next: string | undefined = undefined;
	const nextParam = sanitizeReturnPath(url.searchParams.get("next"));
	if (nextParam) {
		// Only accept absolute in-app paths to prevent open redirects
		next = nextParam;
	} else if (!url.pathname.startsWith(`${base}/login`)) {
		// For automatic login on protected pages, return to the page the user was on
		next = sanitizeReturnPath(`${url.pathname}${url.search}`) ?? `${base}/`;
	} else {
		next = sanitizeReturnPath(`${base}/`) ?? "/";
	}

	const authorizationUrl = await getOIDCAuthorizationUrl(
		{ redirectURI },
		{ sessionId: locals.sessionId, next, url, cookies }
	);

	throw redirect(302, authorizationUrl);
}
