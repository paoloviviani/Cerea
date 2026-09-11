/**
 * Where a connector's authorization server sends the browser back (ADR 0064).
 *
 * This route is the reason this feature is straightforward rather than the
 * ordeal ADR 0063 records: the redirect URI is ours, so it is a path we
 * already serve on an origin the provider can reach, and there is no
 * `localhost`, no tunnel and nothing to negotiate.
 *
 * It is a `GET`, because a redirect is a GET — the CSRF concern a GET usually
 * raises is answered instead by the `state` parameter, which was issued to
 * *this session* and is single-use. A code arriving with a state we did not
 * issue here is discarded.
 *
 * Errors land the person back in the chat with a message rather than on a bare
 * error page: they are mid-task, the connector simply is not connected, and
 * the interesting detail belongs in the log.
 */

import { base } from "$app/paths";
import { redirect, type RequestHandler } from "@sveltejs/kit";
import { completeAuthorization } from "$lib/server/mcp/oauth";
import { logger } from "$lib/server/logger";

/** Back into the app, saying how it went, without leaking detail to the URL. */
function back(
	next: string,
	outcome: "connected" | "failed",
	detail?: string,
	connectorId?: string
): never {
	const url = new URL(next, "http://placeholder");
	url.searchParams.set("mcp", outcome);
	if (detail) url.searchParams.set("mcpDetail", detail);
	// Which connector, so the browser can switch it on rather than leaving
	// somebody to find the toggle after approving a consent screen.
	if (connectorId) url.searchParams.set("mcpConnector", connectorId);
	throw redirect(303, `${url.pathname}${url.search}`);
}

export const GET: RequestHandler = async ({ url, locals }) => {
	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	const denied = url.searchParams.get("error");
	const home = `${base}/`;

	if (denied) {
		// The person said no, or the provider refused. Not an error of ours.
		logger.info({ error: denied }, "mcp_oauth_declined");
		back(home, "failed", denied === "access_denied" ? "declined" : denied);
	}

	if (!state || !code) {
		back(home, "failed", "incomplete");
	}

	if (!locals.sessionId) {
		back(home, "failed", "no-session");
	}

	try {
		const { next, connectorName, connectorId } = await completeAuthorization({
			state,
			code,
			sessionId: locals.sessionId,
		});
		logger.info({ connector: connectorName }, "mcp_oauth_callback_ok");
		back(next || home, "connected", undefined, connectorId);
	} catch (err) {
		// A `redirect` is thrown, so it must not be swallowed as a failure.
		if (err && typeof err === "object" && "status" in err && "location" in err) throw err;
		logger.warn({ err }, "mcp_oauth_callback_failed");
		back(home, "failed", "exchange");
	}
};
