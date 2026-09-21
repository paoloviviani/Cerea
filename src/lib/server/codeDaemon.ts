import { error } from "@sveltejs/kit";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";

/**
 * How the Cerea server reaches the paseo daemon, and with what.
 *
 * The daemon runs on the person's own machine (or behind a relay the
 * operator deploys); either way the browser never talks to it. The base URL
 * (`CODE_DAEMON_URL`) and the service credential (`CODE_DAEMON_TOKEN`) live
 * in the server environment, are attached here, and never reach the page —
 * the same discipline as the gateway forwarder's `token(locals)`, except the
 * credential is the deployment's, not the caller's: the relay is
 * identity-blind, and per-user scoping is brokered by Cerea's pairing
 * records (see `api/v2/code/devices` and `api/v2/code/enroll`).
 *
 * Requests carry a pinned API version (`X-Paseo-Version`). A daemon that
 * answers it with a different version is a 502 here rather than a proxied
 * conversation between strangers: the shapes below were coded against
 * paseo daemon API v1 (workspaces, agents, sessions, messages, permissions,
 * diff — see the allowlist in `api/v2/code/[...path]/+server.ts`), and a
 * version skew would fail in ways neither side describes well.
 */

export const PASEO_API_VERSION = "1";

export function daemonBaseUrl(): string {
	const base = config.CODE_DAEMON_URL?.trim();
	if (!base) {
		error(404, "No coding-agent daemon is configured in this deployment.");
	}
	return base.replace(/\/$/, "");
}

export function daemonHeaders(): Record<string, string> {
	const token = config.CODE_DAEMON_TOKEN?.trim();
	if (!token) {
		// Configured address but no credential: refuse rather than call the
		// daemon unauthenticated, which would fail there with less context.
		error(502, "The coding-agent daemon credential is not configured.");
	}
	return {
		Authorization: `Bearer ${token}`,
		"X-Paseo-Version": PASEO_API_VERSION,
	};
}

/** The daemon's status and body, verbatim, including its refusals. */
export async function relayDaemon(response: Response): Promise<Response> {
	const body = await response.text();
	return new Response(body, {
		status: response.status,
		headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
	});
}

export async function callDaemon(
	path: string,
	init: { method?: string; body?: BodyInit; contentType?: string; signal?: AbortSignal },
	fetchFn: typeof fetch = fetch
): Promise<Response> {
	const base = daemonBaseUrl();
	const headers = daemonHeaders();
	if (init.contentType) headers["content-type"] = init.contentType;
	try {
		return await relayDaemon(
			await fetchFn(`${base}/${path}`, {
				method: init.method ?? "GET",
				headers,
				body: init.body,
				signal: init.signal,
			})
		);
	} catch (err) {
		if (err && typeof err === "object" && "status" in err) throw err;
		logger.error({ err, path }, "paseo daemon call failed");
		error(502, "The coding-agent daemon could not be reached.");
	}
}
