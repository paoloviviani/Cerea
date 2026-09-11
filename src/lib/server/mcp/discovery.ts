/**
 * Asking a remote MCP server how it authenticates (ADR 0064).
 *
 * This replaces deciding it by string-matching an error message for
 * "unauthorized", "forbidden", "401" or "403", which is what
 * `api/mcp/health` did and which cannot tell an authorization server from a
 * typo. The protocol has an answer: a 401 carries `WWW-Authenticate` naming
 * the resource metadata, that document names the authorization servers, and
 * each of those publishes its own metadata.
 *
 * Three things worth knowing before changing it.
 *
 * **A 200 means no OAuth, and that is a real answer.** A server on a private
 * network or a public one authenticates nothing, and saying so is different
 * from "we have not looked", which is a missing `probedAt`.
 *
 * **`resource` is not optional.** RFC 8707's indicator is what stops a token
 * minted for one MCP server being replayed at another, and the MCP spec
 * requires it. The value comes from the protected-resource document rather
 * than being assembled from the URL, because the server is the authority on
 * its own name.
 *
 * **PKCE S256 is required, not preferred.** We are a confidential-ish client
 * with a redirect on a real origin, but the flow still runs through a browser
 * we do not control, and `plain` is a downgrade with no upside. A server
 * offering only `plain` is refused with a reason rather than silently
 * accepted.
 */

import { logger } from "$lib/server/logger";
import { ssrfSafeFetch } from "$lib/server/urlSafety";

export interface DiscoveredOAuth {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
	revocationEndpoint?: string;
	scopesSupported?: string[];
	resource: string;
	supportsS256: boolean;
}

export type Probe =
	| { auth: "none" }
	| { auth: "oauth"; oauth: DiscoveredOAuth }
	| { auth: "unknown"; reason: string };

/** Browser-ish, because some providers filter on the agent. */
const AGENT = "Mozilla/5.0 (compatible; Cerea MCP client)";

async function json(url: string): Promise<Record<string, unknown> | null> {
	try {
		const response = await ssrfSafeFetch(url, {
			headers: { accept: "application/json", "user-agent": AGENT },
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) return null;
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * The metadata URL a 401 points at, per RFC 9728.
 *
 * `WWW-Authenticate: Bearer resource_metadata="https://..."`. Parsed rather
 * than assumed, because a server is allowed to host it anywhere — though the
 * well-known path below is the usual answer and the fallback.
 */
function resourceMetadataUrl(header: string | null, endpoint: string): string {
	const named = header?.match(/resource_metadata="([^"]+)"/i);
	if (named) return named[1];
	const url = new URL(endpoint);
	return `${url.origin}/.well-known/oauth-protected-resource`;
}

/**
 * Both spellings of the authorization server metadata path.
 *
 * RFC 8414 inserts the well-known segment *before* any path on the issuer,
 * which is the spelling implementations most often get wrong; OpenID
 * Connect's discovery appends it instead. Trying both is two requests in the
 * uncommon case and removes a class of failure that presents as "no OAuth
 * here".
 */
function metadataUrls(issuer: string): string[] {
	const url = new URL(issuer);
	const path = url.pathname.replace(/\/$/, "");
	return [
		`${url.origin}/.well-known/oauth-authorization-server${path}`,
		`${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
		`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
	];
}

/** Ask one MCP endpoint what it wants. */
export async function probe(endpoint: string): Promise<Probe> {
	let response: Response;
	try {
		// An empty POST is enough: an MCP server answers 401 before it cares
		// that the body is not a JSON-RPC message, and a GET is not part of
		// the streamable-HTTP transport.
		response = await ssrfSafeFetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"user-agent": AGENT,
			},
			body: "{}",
			signal: AbortSignal.timeout(15_000),
		});
	} catch (err) {
		return {
			auth: "unknown",
			reason: err instanceof Error ? err.message : "the server could not be reached",
		};
	}

	if (response.status !== 401 && response.status !== 403) {
		// Anything that is not a challenge means no OAuth in front of it. A 400
		// is included on purpose: it is what a reachable MCP server says to an
		// empty body, which is exactly the "no auth" case.
		return { auth: "none" };
	}

	const metadataUrl = resourceMetadataUrl(response.headers.get("www-authenticate"), endpoint);
	const resourceDoc = await json(metadataUrl);
	if (!resourceDoc) {
		return {
			auth: "unknown",
			reason: `it asks for authentication but publishes no resource metadata at ${metadataUrl}`,
		};
	}

	const servers = resourceDoc.authorization_servers;
	const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : null;
	if (!issuer) {
		return { auth: "unknown", reason: "its resource metadata names no authorization server" };
	}

	let meta: Record<string, unknown> | null = null;
	for (const candidate of metadataUrls(issuer)) {
		meta = await json(candidate);
		if (meta) break;
	}
	if (!meta) {
		return { auth: "unknown", reason: `${issuer} publishes no authorization server metadata` };
	}

	const authorizationEndpoint = meta.authorization_endpoint;
	const tokenEndpoint = meta.token_endpoint;
	if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
		return { auth: "unknown", reason: `${issuer} publishes no authorization or token endpoint` };
	}

	const methods = Array.isArray(meta.code_challenge_methods_supported)
		? meta.code_challenge_methods_supported.map(String)
		: [];
	const supportsS256 = methods.includes("S256");
	if (!supportsS256) {
		return {
			auth: "unknown",
			reason: `${issuer} does not offer PKCE S256, and this client will not use 'plain'`,
		};
	}

	const resource =
		typeof resourceDoc.resource === "string" ? resourceDoc.resource : new URL(endpoint).origin;

	logger.info(
		{ endpoint, issuer, registration: Boolean(meta.registration_endpoint) },
		"mcp_oauth_discovered"
	);

	return {
		auth: "oauth",
		oauth: {
			issuer: typeof meta.issuer === "string" ? meta.issuer : issuer,
			authorizationEndpoint,
			tokenEndpoint,
			registrationEndpoint:
				typeof meta.registration_endpoint === "string" ? meta.registration_endpoint : undefined,
			revocationEndpoint:
				typeof meta.revocation_endpoint === "string" ? meta.revocation_endpoint : undefined,
			scopesSupported: Array.isArray(resourceDoc.scopes_supported)
				? resourceDoc.scopes_supported.map(String)
				: Array.isArray(meta.scopes_supported)
					? meta.scopes_supported.map(String)
					: undefined,
			resource,
			supportsS256,
		},
	};
}
