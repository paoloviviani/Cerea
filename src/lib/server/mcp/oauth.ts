/**
 * The OAuth client for MCP connectors (ADR 0064).
 *
 * Registration by RFC 7591, PKCE S256, the RFC 8707 resource indicator, and a
 * callback on our own origin — which is the part that makes this
 * straightforward rather than the ordeal ADR 0063 documents. The redirect URI
 * is a route we serve, so there is no localhost, no tunnel, and nothing to
 * negotiate with the provider about where it may send a browser.
 *
 * Three things hold the security of this together.
 *
 * **State is bound to the session and is single-use.** It is stored with the
 * session id that started the flow and deleted when consumed. An authorization
 * code arriving with a state we did not issue to *this* session is discarded —
 * otherwise a callback is a way to attach an attacker's authorisation to
 * somebody else's account, which is the classic CSRF against this flow.
 *
 * **The verifier never leaves the server.** PKCE's point is that an
 * intercepted code cannot be exchanged; that only holds if the verifier is not
 * also in transit. It lives in the pending row.
 *
 * **Tokens are sealed before they are stored.** See `secretBox.ts` for why the
 * key has no default.
 *
 * And every outbound call goes through `ssrfSafeFetch`, which is not optional
 * here. The chain is attacker-influenced end to end: a URL somebody typed names
 * a metadata document, that document names an authorization server, and we then
 * post a client registration and later an authorization *code* to whatever it
 * said. Plain `fetch` would make a connector a way to reach anything the
 * container can — `https://` in the schema stops none of it, since a hostname
 * is free to resolve into the compose network. This was written with `fetch`
 * first and is the one thing in this file that was wrong rather than merely
 * incomplete.
 */

import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { base } from "$app/paths";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { ssrfSafeFetch } from "$lib/server/urlSafety";
import { open, seal } from "./secretBox";
import type { McpConnector, McpRegistration } from "$lib/types/McpConnector";

/** How long a person has to finish a consent screen before the state expires. */
const PENDING_TTL_MINUTES = 15;
/** Refresh this long before expiry, so a call does not race the clock. */
const REFRESH_SKEW_SECONDS = 60;

/**
 * The one redirect URI, registered once per connector and used for every
 * flow.
 *
 * Built from `PUBLIC_ORIGIN` rather than the request, deliberately: a redirect
 * URI that varied with whatever `Host` header arrived would be registered
 * under one value and used under another, and an attacker-supplied `Host`
 * would be a way to move where a code is delivered.
 */
export function redirectUri(): string {
	const origin = config.PUBLIC_ORIGIN;
	if (!origin) {
		throw new Error("PUBLIC_ORIGIN is not set, so the OAuth redirect URI cannot be built");
	}
	return `${origin.replace(/\/$/, "")}${base}/mcp/callback`;
}

/** Register this deployment with a connector's authorization server. */
export async function register(connector: McpConnector): Promise<McpRegistration> {
	const endpoint = connector.oauth?.registrationEndpoint;
	if (!endpoint) {
		throw new Error(
			"this authorization server offers no dynamic registration, so a client id must be " +
				"configured by hand"
		);
	}

	const response = await ssrfSafeFetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: config.PUBLIC_APP_NAME || "Pystino Chat",
			redirect_uris: [redirectUri()],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			// `none` first: PKCE is what protects the exchange, and a public
			// client avoids storing a secret we do not need. A server that
			// insists on a secret will say so in its response, and we store
			// whatever it gives back.
			token_endpoint_auth_method: "none",
			scope: connector.oauth?.scopesSupported?.join(" "),
		}),
		signal: AbortSignal.timeout(20_000),
	});

	const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
	if (!response.ok || !body || typeof body.client_id !== "string") {
		throw new Error(
			`registration failed (${response.status}): ${JSON.stringify(body)?.slice(0, 200)}`
		);
	}

	logger.info(
		{ connector: connector.name, issuer: connector.oauth?.issuer },
		"mcp_oauth_registered"
	);

	return {
		clientId: body.client_id,
		clientSecretSealed:
			typeof body.client_secret === "string" ? seal(body.client_secret) : undefined,
		registeredAt: new Date(),
		source: "dcr",
	};
}

/**
 * A registration somebody already holds, rather than one we asked for.
 *
 * Open WebUI calls this shape `oauth_2.1_static` and it exists for the same
 * reason there: a provider is free not to offer RFC 7591 at all, and without
 * this such a server cannot be signed in to — `canAuthorize` is false and the
 * button is disabled, which is a dead end rather than an inconvenience.
 *
 * Everything else is unchanged. Metadata discovery still finds the endpoints,
 * PKCE still protects the exchange, and the token endpoint already sends
 * `client_secret` in the form when one is present — so a confidential client
 * needed no new code path, only a way to say what its credentials are.
 */
export function staticRegistration(options: {
	clientId: string;
	clientSecret?: string;
}): McpRegistration {
	return {
		clientId: options.clientId,
		clientSecretSealed: options.clientSecret ? seal(options.clientSecret) : undefined,
		registeredAt: new Date(),
		source: "static",
	};
}

/**
 * Begin a flow: returns the URL to send the browser to.
 *
 * Registers first if this connector has never been registered, so that adding
 * a connector and signing in to it is one action for the person doing it.
 */
export async function beginAuthorization(options: {
	connector: McpConnector;
	userId: ObjectId;
	sessionId: string;
	/** Where to land afterwards, within this app. */
	next?: string;
}): Promise<string> {
	const { connector, userId, sessionId, next } = options;
	const oauth = connector.oauth;
	if (!oauth) throw new Error("this connector has no discovered OAuth configuration");

	let registration = connector.registration;
	if (!registration) {
		registration = await register(connector);
		await collections.mcpConnectors.updateOne(
			{ _id: connector._id },
			{ $set: { registration, updatedAt: new Date() } }
		);
	}

	// PKCE. The verifier stays here; only its hash travels.
	const verifier = randomBytes(48).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = randomBytes(32).toString("base64url");

	await collections.mcpOauthPending.insertOne({
		_id: new ObjectId(),
		state,
		connectorId: connector._id,
		userId,
		// The session that started it, so the callback can refuse a code that
		// arrives in anybody else's browser.
		sessionId,
		verifier,
		next: next ?? `${base}/`,
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + PENDING_TTL_MINUTES * 60_000),
	});

	const url = new URL(oauth.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", registration.clientId);
	url.searchParams.set("redirect_uri", redirectUri());
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	// RFC 8707. Required by the MCP spec, and what stops this token being
	// replayed at a different MCP server.
	url.searchParams.set("resource", oauth.resource);
	if (oauth.scopesSupported?.length) {
		url.searchParams.set("scope", oauth.scopesSupported.join(" "));
	}
	return url.toString();
}

export interface Exchanged {
	next: string;
	/** For the log line, which should name a connector rather than an id. */
	connectorName: string;
	/**
	 * For the callback to put in the URL, so the browser can switch on the
	 * connector that was just authorised. Safe to expose: it addresses a row
	 * this person owns, and every use of it re-checks that ownership and looks
	 * the token up by `(userId, connectorId)`.
	 */
	connectorId: string;
}

/**
 * Finish a flow: exchange the code and store the tokens for that person.
 *
 * The session id is checked rather than trusted from the state alone, which is
 * the difference between a CSRF-protected callback and a decorative one.
 */
export async function completeAuthorization(options: {
	state: string;
	code: string;
	sessionId: string;
}): Promise<Exchanged> {
	const { state, code, sessionId } = options;

	// Consumed in one step, so a replayed code finds nothing — the atomicity
	// is the protection, not a tidiness.
	//
	// Driver v5 wraps the document in a ModifyResult, as `parkedSweeper.ts`
	// also notes.
	const result = await collections.mcpOauthPending.findOneAndDelete({ state });
	const pending = result?.value ?? null;
	if (!pending) throw new Error("this sign-in has expired or was already completed");
	if (pending.sessionId !== sessionId) {
		logger.warn({ state: state.slice(0, 8) }, "mcp_oauth_state_session_mismatch");
		throw new Error("this sign-in was started in a different session");
	}
	if (pending.expiresAt.getTime() < Date.now()) {
		throw new Error("this sign-in expired before it was completed");
	}

	const connector = await collections.mcpConnectors.findOne({ _id: pending.connectorId });
	if (!connector?.oauth || !connector.registration) {
		throw new Error("that connector is gone, or is no longer configured for OAuth");
	}

	const form: Record<string, string> = {
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri(),
		client_id: connector.registration.clientId,
		code_verifier: pending.verifier,
		resource: connector.oauth.resource,
	};
	if (connector.registration.clientSecretSealed) {
		form.client_secret = open(connector.registration.clientSecretSealed);
	}

	const response = await ssrfSafeFetch(connector.oauth.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form).toString(),
		signal: AbortSignal.timeout(20_000),
	});
	const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
	if (!response.ok || !body || typeof body.access_token !== "string") {
		throw new Error(
			`the token exchange failed (${response.status}): ` + `${JSON.stringify(body)?.slice(0, 200)}`
		);
	}

	await storeTokens({
		connectorId: connector._id,
		userId: pending.userId,
		body,
	});

	logger.info({ connector: connector.name }, "mcp_oauth_connected");
	return {
		next: pending.next,
		connectorName: connector.name,
		connectorId: connector._id.toString(),
	};
}

async function storeTokens(options: {
	connectorId: ObjectId;
	userId: ObjectId;
	body: Record<string, unknown>;
}): Promise<void> {
	const { connectorId, userId, body } = options;
	const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
	const now = new Date();

	await collections.mcpTokens.updateOne(
		{ connectorId, userId },
		{
			$set: {
				accessTokenSealed: seal(String(body.access_token)),
				// Kept only when given: a server that issues none means the
				// person signs in again when it expires, which is correct
				// rather than something to paper over.
				...(typeof body.refresh_token === "string"
					? { refreshTokenSealed: seal(body.refresh_token) }
					: {}),
				...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1000) } : {}),
				...(typeof body.scope === "string" ? { scope: body.scope } : {}),
				updatedAt: now,
			},
			$setOnInsert: { _id: new ObjectId(), connectorId, userId, createdAt: now },
		},
		{ upsert: true }
	);
}

/**
 * The bearer token to use for one person on one connector, or null.
 *
 * Refreshes shortly *before* expiry rather than after a 401, so a tool call
 * does not fail on a clock boundary. A refresh that fails deletes the row: the
 * honest outcome is "sign in again", and keeping a dead token would make every
 * later call fail the same way with no prompt.
 */
export async function bearerFor(options: {
	connector: McpConnector;
	userId: ObjectId;
}): Promise<string | null> {
	const { connector, userId } = options;

	if (connector.auth === "none") return null;
	if (connector.auth === "token") {
		return connector.tokenSealed ? open(connector.tokenSealed) : null;
	}

	const row = await collections.mcpTokens.findOne({ connectorId: connector._id, userId });
	if (!row) return null;

	const stillGood =
		!row.expiresAt || row.expiresAt.getTime() - REFRESH_SKEW_SECONDS * 1000 > Date.now();
	if (stillGood) return open(row.accessTokenSealed);

	if (!row.refreshTokenSealed || !connector.oauth || !connector.registration) {
		await collections.mcpTokens.deleteOne({ _id: row._id });
		return null;
	}

	const form: Record<string, string> = {
		grant_type: "refresh_token",
		refresh_token: open(row.refreshTokenSealed),
		client_id: connector.registration.clientId,
		resource: connector.oauth.resource,
	};
	if (connector.registration.clientSecretSealed) {
		form.client_secret = open(connector.registration.clientSecretSealed);
	}

	try {
		const response = await ssrfSafeFetch(connector.oauth.tokenEndpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(form).toString(),
			signal: AbortSignal.timeout(20_000),
		});
		const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
		if (!response.ok || !body || typeof body.access_token !== "string") {
			throw new Error(`refresh failed (${response.status})`);
		}
		await storeTokens({ connectorId: connector._id, userId, body });
		return String(body.access_token);
	} catch (err) {
		logger.info({ err, connector: connector.name }, "mcp_oauth_refresh_failed");
		await collections.mcpTokens.deleteOne({ _id: row._id });
		return null;
	}
}
