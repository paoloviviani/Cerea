/**
 * Server-to-server OIDC over an internal URL.
 *
 * In the Pystino stack the bundled Authelia is published to browsers at
 * `https://<origin>/authelia` and reachable from this container at
 * `http://authelia:9091/authelia`. Calling the public URL from here hairpins
 * through the proxy's TLS listener, which is what needed a CA trust bundle
 * (`NODE_EXTRA_CA_CERTS`) that decayed every time the proxy's data volume was
 * recreated. With `OPENID_INTERNAL_URL` set, discovery, token, JWKS and
 * userinfo go to the internal URL instead, carrying `X-Forwarded-Proto/Host`
 * for the public issuer — Authelia derives its issuer, and the `iss` of what
 * it mints, from those headers, and answers nothing without them. The browser
 * still gets the public authorization and logout endpoints.
 *
 * Mirrors the gateway's `OIDCClient` back-channel, so both halves of the stack
 * follow one rule (deployment re-architecture report, §2).
 */
import type { CustomHttpOptionsProvider, IssuerMetadata } from "openid-client";

export function forwardedHeaders(providerUrl: string): Record<string, string> {
	const url = new URL(providerUrl);
	return { "x-forwarded-proto": url.protocol.replace(/:$/, ""), "x-forwarded-host": url.host };
}

/** Move an endpoint under the public issuer onto the internal base; leave others alone. */
export function toInternal(
	endpoint: string | undefined,
	providerUrl: string,
	internalUrl: string
): string | undefined {
	const publicBase = providerUrl.replace(/\/+$/, "");
	const internalBase = internalUrl.replace(/\/+$/, "");
	if (!endpoint || !endpoint.startsWith(publicBase)) return endpoint;
	return internalBase + endpoint.slice(publicBase.length);
}

/**
 * Discovery through the internal URL, with back-channel endpoints rewritten.
 *
 * Throws when the IdP answers with an issuer other than the public one — the
 * forwarded headers were ignored, and every login would otherwise fail later
 * with a token error that names the wrong cause.
 */
export async function discoverViaInternal(
	providerUrl: string,
	internalUrl: string,
	fetchImpl: typeof fetch = fetch
): Promise<IssuerMetadata> {
	const base = internalUrl.replace(/\/+$/, "");
	const response = await fetchImpl(`${base}/.well-known/openid-configuration`, {
		headers: forwardedHeaders(providerUrl),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new Error(`OIDC discovery via ${base} failed: HTTP ${response.status}`);
	}
	const document = (await response.json()) as IssuerMetadata;
	if (String(document.issuer).replace(/\/+$/, "") !== providerUrl.replace(/\/+$/, "")) {
		throw new Error(
			`OIDC discovery via ${base} reports issuer ${document.issuer}, not ${providerUrl}: ` +
				"the identity provider did not honour X-Forwarded-Host/Proto"
		);
	}
	return {
		...document,
		token_endpoint: toInternal(document.token_endpoint, providerUrl, internalUrl),
		jwks_uri: toInternal(document.jwks_uri, providerUrl, internalUrl),
		userinfo_endpoint: toInternal(document.userinfo_endpoint, providerUrl, internalUrl),
		introspection_endpoint: toInternal(
			document.introspection_endpoint as string | undefined,
			providerUrl,
			internalUrl
		),
		revocation_endpoint: toInternal(
			document.revocation_endpoint as string | undefined,
			providerUrl,
			internalUrl
		),
	};
}

/**
 * An openid-client `custom.http_options` hook adding the forwarded headers.
 *
 * Returns only the headers: openid-client deep-merges the hook's result over
 * the request's own options (`defaultsDeep` in lib/helpers/request.js, 5.7),
 * so the Authorization header and everything else survive.
 */
export function withForwardedHeaders(providerUrl: string): CustomHttpOptionsProvider {
	const extra = forwardedHeaders(providerUrl);
	return () => ({ headers: { ...extra } });
}
