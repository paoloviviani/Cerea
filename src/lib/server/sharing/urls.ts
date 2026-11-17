import { base } from "$app/paths";
import { config } from "$lib/server/config";

/**
 * Where share links live (ADR 0120). Two shapes, chosen by the operator:
 *
 * - a **subdomain** (`ARTIFACT_SHARE_ORIGIN`, e.g. https://share.example.org):
 *   anyone's links are `<origin>/<token>`; the proxy routes that host to the share
 *   handler only, and those pages never run on the app's own origin;
 * - a **path** on the app's origin (`ARTIFACT_SHARE_PATH`, `/s` by default):
 *   `<app origin><path>/<token>`. Signed-in links always use it.
 *
 * The app itself serves `<base>/s/<token>`; a proxy that publishes another
 * prefix (the kit's Caddy does) rewrites it.
 */
export function shareOrigin(): string | undefined {
	const value = (config.ARTIFACT_SHARE_ORIGIN ?? "").trim().replace(/\/+$/, "");
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
	} catch {
		return undefined;
	}
}

/** The host (with port) requests on the share origin carry, when there is one. */
export function shareHost(): string | undefined {
	const origin = shareOrigin();
	return origin ? new URL(origin).host : undefined;
}

/** The path prefix the app serves links at, on its own origin: `<base>/s` unless the operator publishes another. */
export function sharePath(): string {
	const raw = (config.ARTIFACT_SHARE_PATH ?? "").trim().replace(/\/+$/, "");
	if (!raw) return `${base}/s`;
	return raw.startsWith("/") ? raw : `/${raw}`;
}

/**
 * The public URL of a link; the token is only ever known when it is made.
 * Anyone's links use the share subdomain when there is one. Signed-in links
 * always use the path on the app's own origin, whatever is configured: they
 * need the visitor's session, which the cookie-free share host cannot see.
 */
export function shareUrl(token: string, audience: "signed_in" | "anyone"): string {
	const origin = shareOrigin();
	if (audience === "anyone" && origin) return `${origin}/${token}`;
	const app = (config.PUBLIC_ORIGIN ?? "").trim().replace(/\/+$/, "");
	return `${app}${sharePath()}/${token}`;
}

/** Whether public (anyone) links share the app's origin: no subdomain is set. */
export function sharedOnAppOrigin(): boolean {
	return !shareOrigin();
}
