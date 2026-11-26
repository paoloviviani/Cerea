import { config } from "$lib/server/config";
import { error } from "@sveltejs/kit";

/**
 * The checks the routes an MCP App card posts to share: a JSON body, from this site's own origin (the
 * origins the app answers on, as the CSRF check in the request hook reads them). A page itself cannot
 * reach them (opaque origin, no session cookie); this is the second wall.
 */
export function requireSameOriginJson(request: Request, url: URL): void {
	if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
		error(415, "Expected application/json");
	}
	const origin = request.headers.get("origin");
	const validHosts = [
		new URL(request.url).host,
		url.host,
		...(config.PUBLIC_ORIGIN ? [new URL(config.PUBLIC_ORIGIN).host] : []),
	];
	let originHost: string | undefined;
	try {
		originHost = origin ? new URL(origin).host : undefined;
	} catch {
		originHost = undefined;
	}
	if (!originHost || !validHosts.includes(originHost)) error(403, "Cross-origin request");
}
