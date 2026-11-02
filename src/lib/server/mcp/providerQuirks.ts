/**
 * Where an authorization server's own habits are handled, so `oauth.ts` stays
 * the protocol and not a list of vendors.
 *
 * Only add a rule here for a provider that breaks without it, with the reason.
 */

/** The hosts Google signs people in and issues tokens on. */
const GOOGLE_HOSTS = new Set(["accounts.google.com", "oauth2.googleapis.com"]);

/** Whether an OAuth endpoint or issuer URL belongs to Google. */
export function isGoogle(url: string | undefined): boolean {
	if (!url) return false;
	try {
		return GOOGLE_HOSTS.has(new URL(url).hostname);
	} catch {
		return false;
	}
}

/**
 * Extra authorization-request parameters a provider needs.
 *
 * Google issues a refresh token only when asked for `access_type=offline`, and
 * reliably only with `prompt=consent` (without it, a second consent for the
 * same client returns no refresh token). Without both, a Google connection
 * stops working after about an hour, when the access token expires.
 */
export function authorizationParams(oauth: {
	issuer?: string;
	authorizationEndpoint: string;
}): Record<string, string> {
	if (isGoogle(oauth.authorizationEndpoint) || isGoogle(oauth.issuer)) {
		return { access_type: "offline", prompt: "consent" };
	}
	return {};
}

/**
 * Whether to send the RFC 8707 `resource` parameter to this authorization
 * server's endpoints.
 *
 * Google's OAuth does not implement resource indicators: its tokens are bound
 * to scopes, not to a resource, so the parameter can only be ignored or
 * rejected. Leaving it out loses nothing, and avoids a refusal we cannot test
 * from here.
 */
export function sendsResource(oauth: { issuer?: string; tokenEndpoint: string }): boolean {
	return !(isGoogle(oauth.tokenEndpoint) || isGoogle(oauth.issuer));
}

/**
 * The scopes to request: the connector's own list when it has one, otherwise
 * everything the server advertises (today's behaviour). `undefined` sends none.
 */
export function requestedScopes(connector: {
	scopes?: string[];
	oauth?: { scopesSupported?: string[] };
}): string[] | undefined {
	if (connector.scopes?.length) return connector.scopes;
	return connector.oauth?.scopesSupported?.length ? connector.oauth.scopesSupported : undefined;
}

/** Split what somebody typed (spaces, commas or new lines) into distinct scope tokens. */
export function parseScopes(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).filter(Boolean))];
}

/**
 * The API's "Scopes" field: text in, distinct tokens out, or a validation
 * message. An empty string is valid and means "use the advertised scopes".
 */
export function validateScopes(text: string): { scopes: string[] } | { error: string } {
	if (text.length > 4000) return { error: "Scopes are too long." };
	const scopes = parseScopes(text);
	if (scopes.length > 100) return { error: "Too many scopes (100 at most)." };
	// RFC 6749 3.3: printable ASCII except double quote and backslash.
	if (scopes.some((s) => s.length > 512 || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(s))) {
		return { error: "A scope may only hold printable characters, and no quotes." };
	}
	return { scopes };
}
