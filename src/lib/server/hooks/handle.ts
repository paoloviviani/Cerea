import type { Handle, RequestEvent } from "@sveltejs/kit";
import { collections } from "$lib/server/database";
import { base } from "$app/paths";
import { dev } from "$app/environment";
import {
	authenticateRequest,
	loginEnabled,
	refreshSessionCookie,
	triggerOauthFlow,
} from "$lib/server/auth";
import { ERROR_MESSAGES } from "$lib/stores/errors";
import { addWeeks } from "date-fns";
import { logger } from "$lib/server/logger";
import { isHostLocalhost } from "$lib/server/isURLLocal";
import { runWithRequestContext, updateRequestContext } from "$lib/server/requestContext";
import { config, ready } from "$lib/server/config";

type HandleInput = Parameters<Handle>[0];

function getClientAddressSafe(event: RequestEvent): string | undefined {
	try {
		return event.getClientAddress();
	} catch {
		return undefined;
	}
}

/**
 * Routes under /admin that a *program* calls, with a static shared secret.
 *
 * Enumerated rather than matched by prefix because /admin now also holds an
 * administration UI for people, and the two need opposite credentials: a
 * secret in a header for the cron job, a signed-in session for the human.
 */
const MACHINE_ADMIN_ROUTES = new Set(["/admin/stats/compute"]);
const MACHINE_ADMIN_PATHS = ["/admin/stats/compute"];

/**
 * Routes anyone may fetch with no session: galopin's binaries and installer
 * (`/galopin/[file]`), fetched by `curl` on a machine that has never signed
 * in. Matched by route id, not path prefix, so nothing else that happens to
 * live under the path inherits the exemption; the route itself serves only a
 * fixed allowlist of names (`galopinDist.ts`).
 */
const PUBLIC_ROUTES = new Set(["/galopin/[file]"]);

/**
 * The gateway's own service-to-service calls (ADR 0093 §9.3): a static
 * bearer (`CHAT_ERASURE_TOKEN`), compared in constant time by the route
 * itself (`internalAuth.ts`'s `assertInternalRequest`), never a signed-in
 * session — so, like `MACHINE_ADMIN_ROUTES`, exempted from the browser
 * login wall rather than widened to fit it. Matched by route id: nothing
 * else under `/internal/*` inherits this by accident.
 */
const INTERNAL_SERVICE_ROUTES = new Set(["/internal/erasure", "/internal/erasure/preview"]);

export async function handleRequest({ event, resolve }: HandleInput): Promise<Response> {
	// Generate a unique request ID for this request
	const requestId = crypto.randomUUID();

	// Run the entire request handling within the request context
	return runWithRequestContext(
		async () => {
			await ready.then(() => {
				config.checkForUpdates();
			});

			logger.debug(
				{
					locals: event.locals,
					url: event.url.pathname,
					params: event.params,
					request: event.request,
				},
				"Request received"
			);

			function errorResponse(status: number, message: string) {
				const sendJson =
					event.request.headers.get("accept")?.includes("application/json") ||
					event.request.headers.get("content-type")?.includes("application/json");
				return new Response(sendJson ? JSON.stringify({ error: message }) : message, {
					status,
					headers: {
						"content-type": sendJson ? "application/json" : "text/plain",
					},
				});
			}

			// The two *machine* endpoints under /admin, and only those. This used
			// to catch every route beginning /admin, which was right while /admin
			// meant nothing but those two: a static shared secret is the correct
			// credential for a cron job hitting an export.
			//
			// It is the wrong credential for a person, and since ADR 0062 there is
			// an administration UI under here. A browser cannot put a bearer token
			// on a navigation, so the old rule made the page unreachable — and
			// widening the secret to cover it would have meant one shared password
			// standing in for "is this person an administrator", which is a worse
			// answer than the session already in hand. The UI is gated by the
			// signed-in user, and by the gateway refusing anyone who is not one.
			if (MACHINE_ADMIN_ROUTES.has(event.route.id ?? "")) {
				const ADMIN_SECRET = config.ADMIN_API_SECRET || config.PARQUET_EXPORT_SECRET;

				if (!ADMIN_SECRET) {
					return errorResponse(500, "Admin API is not configured");
				}

				if (event.request.headers.get("Authorization") !== `Bearer ${ADMIN_SECRET}`) {
					return errorResponse(401, "Unauthorized");
				}
			}

			// The machine link (`/api/v2/code/machine`) never reaches here at
			// all — it is a raw WebSocket upgrade, intercepted on the
			// underlying http.Server before SvelteKit's request handling ever
			// sees it (`server.js`, `machineServer.ts`). No exemption needed.
			const auth = await authenticateRequest(event.cookies, event.url);

			event.locals.sessionId = auth.sessionId;

			if (
				loginEnabled &&
				!auth.user &&
				!event.url.pathname.startsWith(`${base}/.well-known/`) &&
				!PUBLIC_ROUTES.has(event.route.id ?? "") &&
				!INTERNAL_SERVICE_ROUTES.has(event.route.id ?? "")
			) {
				if (config.AUTOMATIC_LOGIN === "true") {
					// AUTOMATIC_LOGIN: always redirect to OAuth flow (unless already on login or healthcheck pages)
					if (
						!event.url.pathname.startsWith(`${base}/login`) &&
						!event.url.pathname.startsWith(`${base}/healthcheck`) &&
						// Signing out must reach the logout route even when this
						// session is already gone: intercepted here instead, the
						// browser is silently re-authenticated by the provider's
						// still-live SSO session and Sign out does nothing at all.
						event.url.pathname !== `${base}/logout` &&
						// The API answers for itself with a 401. Redirected here
						// instead, a signed-out `fetch` follows it to the provider
						// and back as HTML, and every caller that checked
						// `response.ok` now dies on a JSON parse. The non-automatic
						// branch below has always exempted `/api`; this one agreeing
						// is the fix, not the exception.
						!event.url.pathname.startsWith(`${base}/api`)
					) {
						// To get the same CSRF token after callback
						refreshSessionCookie(event.cookies, auth.secretSessionId);
						return await triggerOauthFlow(event);
					}
				} else {
					// Redirect to OAuth flow unless on the authorized pages (home, shared conversation, login, healthcheck, model thumbnails)
					if (
						event.url.pathname !== `${base}/` &&
						event.url.pathname !== `${base}` &&
						!event.url.pathname.startsWith(`${base}/login`) &&
						!event.url.pathname.startsWith(`${base}/login/callback`) &&
						!event.url.pathname.startsWith(`${base}/healthcheck`) &&
						// Same reason as the AUTOMATIC_LOGIN branch above: a logout
						// the wall intercepts becomes a login, and the sign-out the
						// person asked for never happens.
						event.url.pathname !== `${base}/logout` &&
						!event.url.pathname.startsWith(`${base}/r/`) &&
						!event.url.pathname.startsWith(`${base}/conversation/`) &&
						!event.url.pathname.startsWith(`${base}/models/`) &&
						!event.url.pathname.startsWith(`${base}/api`)
					) {
						refreshSessionCookie(event.cookies, auth.secretSessionId);
						return triggerOauthFlow(event);
					}
				}
			}

			event.locals.user = auth.user || undefined;
			event.locals.token = auth.token;

			// Update request context with user after authentication
			if (auth.user?.username) {
				updateRequestContext({ user: auth.user.username });
			}

			// ADR 0093 §4.4: `auth.isAdmin` already folds in the gateway's answer
			// (`gatewaySessionCheck`'s `is_admin`) and the admin-token fallback —
			// this used to recompute from `event.locals.user?.isAdmin` instead,
			// which is always `false` on a gateway preset
			// (`updateUser.ts`'s login callback never sets it, by design: the
			// gateway decides), so the gateway's admin grant never reached this
			// app. Pre-existing, fixed here because it is this section's own
			// wiring; flagged in the worker's report.
			event.locals.isAdmin = auth.isAdmin;

			// The gateway has been unreachable for more than five minutes
			// straight for this session (`gatewaySessionCheck`'s `unavailable`).
			// Answering normally would mean guessing whether the account is
			// still active or still admin; 503 says plainly that verification
			// failed. The session is not deleted — it resumes on its own once
			// the gateway answers again — so login/logout/healthcheck still
			// need to go through.
			if (
				auth.gatewayUnavailable &&
				!event.url.pathname.startsWith(`${base}/healthcheck`) &&
				!event.url.pathname.startsWith(`${base}/login`) &&
				event.url.pathname !== `${base}/logout` &&
				!event.url.pathname.startsWith(`${base}/.well-known/`)
			) {
				return errorResponse(503, "can't verify your account; the gateway is unreachable");
			}

			// CSRF protection
			const requestContentType = event.request.headers.get("content-type")?.split(";")[0] ?? "";
			/** https://developer.mozilla.org/en-US/docs/Web/HTML/Element/form#attr-enctype */
			const nativeFormContentTypes = [
				"multipart/form-data",
				"application/x-www-form-urlencoded",
				"text/plain",
			];

			if (event.request.method === "POST") {
				if (nativeFormContentTypes.includes(requestContentType)) {
					const origin = event.request.headers.get("origin");

					if (!origin) {
						return errorResponse(403, "Non-JSON form requests need to have an origin");
					}

					const validOrigins = [
						new URL(event.request.url).host,
						...(config.PUBLIC_ORIGIN ? [new URL(config.PUBLIC_ORIGIN).host] : []),
					];

					if (!validOrigins.includes(new URL(origin).host)) {
						return errorResponse(403, "Invalid referer for POST request");
					}
				}
			}

			// Every /api body must say what it is. The Origin check above only
			// looks at the *native form* content types a <form> can produce; a
			// cross-site `fetch(url, { mode: "no-cors", body: new Blob([json]) })`
			// needs no preflight and — because a typeless Blob gets no
			// Content-Type header at all — carries neither an Origin header this
			// hook demands nor a content-type the old check recognized, and
			// sailed through with the cookie attached regardless. A request with
			// an actual body now has to name a type this app understands.
			//
			// Routes with their own raw-body contract (checked against their own
			// allow-list downstream) are named here rather than widening the
			// types accepted everywhere: `/api/transcribe` takes the recorded
			// clip's own MIME type (audio/webm, audio/wav, ...), never JSON or a
			// form.
			const RAW_BODY_API_PATHS = new Set([`${base}/api/transcribe`]);

			if (
				event.url.pathname.startsWith(`${base}/api/`) &&
				!["GET", "HEAD", "OPTIONS"].includes(event.request.method) &&
				!RAW_BODY_API_PATHS.has(event.url.pathname)
			) {
				const contentLength = event.request.headers.get("content-length");
				const hasBody =
					(contentLength !== null && contentLength !== "0") ||
					event.request.headers.get("transfer-encoding") !== null;

				if (hasBody) {
					const type = requestContentType.toLowerCase();
					if (type !== "application/json" && type !== "multipart/form-data") {
						return errorResponse(
							415,
							"Unsupported Media Type: /api requests with a body need Content-Type: application/json (or multipart/form-data for uploads)"
						);
					}
				}
			}

			if (
				event.request.method === "POST" ||
				event.url.pathname.startsWith(`${base}/login`) ||
				event.url.pathname.startsWith(`${base}/login/callback`)
			) {
				// if the request is a POST request or login-related we refresh the cookie
				refreshSessionCookie(event.cookies, auth.secretSessionId);

				await collections.sessions.updateOne(
					{ sessionId: auth.sessionId },
					{ $set: { updatedAt: new Date(), expiresAt: addWeeks(new Date(), 2) } }
				);
			}

			if (
				loginEnabled &&
				!event.locals.user &&
				!event.url.pathname.startsWith(`${base}/login`) &&
				// The admin machine endpoints only, not the whole /admin tree:
				// they authenticate with a static secret and carry no session,
				// so the login wall would refuse the cron job that is entitled
				// to them. The administration UI under /admin is deliberately
				// *not* exempt — it is a person, and a person has to be signed
				// in. (The machine link has no such exemption to carry here: it
				// never reaches this hook at all, see `isApi` above.)
				!MACHINE_ADMIN_PATHS.some((path) => event.url.pathname.startsWith(`${base}${path}`)) &&
				!INTERNAL_SERVICE_ROUTES.has(event.route.id ?? "") &&
				!event.url.pathname.startsWith(`${base}/settings`) &&
				// And `/logout` answers for itself: refusing a 401 to a session
				// that is already gone is refusing to clean up after it.
				event.url.pathname !== `${base}/logout` &&
				!["GET", "OPTIONS", "HEAD"].includes(event.request.method)
			) {
				return errorResponse(401, ERROR_MESSAGES.authOnly);
			}

			let replaced = false;

			const response = await resolve(event, {
				transformPageChunk: (chunk) => {
					// For some reason, Sveltekit doesn't let us load env variables from .env in the app.html template
					if (replaced || !chunk.html.includes("%gaId%")) {
						return chunk.html;
					}
					replaced = true;

					return chunk.html.replace("%gaId%", config.PUBLIC_GOOGLE_ANALYTICS_ID);
				},
				filterSerializedResponseHeaders: (header) => {
					return header.includes("content-type");
				},
			});

			// Update request context with status code
			updateRequestContext({ statusCode: response.status });

			// Add CSP header to control iframe embedding
			// Always allow huggingface.co; when ALLOW_IFRAME=true, allow all domains
			if (config.ALLOW_IFRAME !== "true") {
				response.headers.append(
					"Content-Security-Policy",
					"frame-ancestors https://huggingface.co;"
				);
			}

			if (
				event.url.pathname.startsWith(`${base}/login/callback`) ||
				event.url.pathname.startsWith(`${base}/login`)
			) {
				response.headers.append("Cache-Control", "no-store");
			}

			if (event.url.pathname.startsWith(`${base}/api/`)) {
				// get origin from the request
				const requestOrigin = event.request.headers.get("origin");

				// get origin from the config if its defined
				let allowedOrigin = config.PUBLIC_ORIGIN ? new URL(config.PUBLIC_ORIGIN).origin : undefined;

				if (
					dev || // if we're in dev mode
					!requestOrigin || // or the origin is null (SSR)
					isHostLocalhost(new URL(requestOrigin).hostname) // or the origin is localhost
				) {
					allowedOrigin = "*"; // allow all origins
				} else if (allowedOrigin === requestOrigin) {
					allowedOrigin = requestOrigin; // echo back the caller
				}

				if (allowedOrigin) {
					response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
					response.headers.set(
						"Access-Control-Allow-Methods",
						"GET, POST, PUT, PATCH, DELETE, OPTIONS"
					);
					response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
				}
			}

			logger.info("Request completed");

			return response;
		},
		{ requestId, url: event.url.pathname, ip: getClientAddressSafe(event) }
	);
}
