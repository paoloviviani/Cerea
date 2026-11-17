import type { RequestEvent } from "@sveltejs/kit";
import { authenticateRequest } from "$lib/server/auth";
import { config } from "$lib/server/config";
import { resolveLocale } from "$lib/i18n/resolve";
import { runWithLocale } from "$lib/server/requestLocale";
import { publicHeaders } from "./pages";
import { shareRateLimited } from "./rateLimit";
import { clientIp, onShareHost } from "./serve";

/**
 * The routes that answer the public (ADR 0120). They run before the login wall,
 * and the hook below keeps them out of the session machinery: no session is
 * created, no cookie is set, and on the share subdomain none is read either.
 */
export const PUBLIC_SHARE_ROUTES: ReadonlySet<string> = new Set([
	"/s/[token]",
	"/s/[token]/doc",
	"/s/[token]/file/[...name]",
]);

export function isPublicShareRoute(routeId: string | null): boolean {
	return routeId !== null && PUBLIC_SHARE_ROUTES.has(routeId);
}

type Resolve = (event: RequestEvent) => Response | Promise<Response>;

export async function handlePublicShare(event: RequestEvent, resolve: Resolve): Promise<Response> {
	const locale = resolveLocale({
		saved: undefined,
		cookie: undefined,
		acceptLanguage: event.request.headers.get("accept-language"),
		pseudo: false,
	});
	event.locals.locale = locale;
	event.locals.sessionId = "";
	event.locals.isAdmin = false;

	return runWithLocale(locale, event.url.origin, async () => {
		if (shareRateLimited(clientIp(event))) {
			return new Response("Too many requests", {
				status: 429,
				headers: publicHeaders({ "Content-Type": "text/plain", "Retry-After": "60" }),
			});
		}
		// A signed-in link uses the visitor's session on the app's own origin: read, never
		// created or refreshed. The share host reads no cookies at all.
		if (!onShareHost(event) && event.cookies.get(config.COOKIE_NAME)) {
			const auth = await authenticateRequest(event.cookies, event.url).catch(() => undefined);
			if (auth?.user) event.locals.user = auth.user;
		}

		const response = await resolve(event);
		// Nothing a public response carries may set a cookie.
		response.headers.delete("set-cookie");
		return response;
	});
}
