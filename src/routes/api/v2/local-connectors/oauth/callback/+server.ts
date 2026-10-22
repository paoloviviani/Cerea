/**
 * Where a local connector's authorization server sends the browser back (ADR 0102,
 * PROTOCOL.md §10.5): `<origin><base>/api/v2/local-connectors/oauth/callback`.
 *
 * Needs a signed-in session, and the `state` must be one this person's session started, once,
 * within ten minutes, for a machine they still own (`localOauth.ts`). The code is handed to the
 * machine, which exchanges it and keeps the tokens; Cerea never sees one. Lands the person back
 * in the app with the outcome in the query, like a remote connector's callback.
 */

import { redirect, type RequestHandler } from "@sveltejs/kit";
import { base } from "$app/paths";
import { logger } from "$lib/server/logger";
import { localConnectorsEnabled } from "$lib/server/codeEnabled";
import { LocalOauthError, completeLocalSignIn, safeNext } from "$lib/server/mcp/localOauth";

function back(
	next: string,
	outcome: "connected" | "failed",
	detail?: string,
	connectorId?: string
): never {
	const url = new URL(safeNext(next), "http://placeholder");
	url.searchParams.set("mcp", outcome);
	if (detail) url.searchParams.set("mcpDetail", detail);
	if (connectorId) url.searchParams.set("mcpConnector", connectorId);
	throw redirect(303, `${url.pathname}${url.search}`);
}

export const GET: RequestHandler = async ({ url, locals }) => {
	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	const denied = url.searchParams.get("error");
	const home = `${base}/workspace?tab=mcp`;

	if (!localConnectorsEnabled()) back(home, "failed", "disabled");
	if (denied) {
		logger.info({ error: denied }, "mcp_local_oauth_declined");
		back(home, "failed", denied === "access_denied" ? "declined" : denied);
	}
	if (!state || !code) back(home, "failed", "incomplete");
	if (!locals.sessionId || !locals.user) back(home, "failed", "no-session");

	try {
		const done = await completeLocalSignIn({
			userId: locals.user._id,
			sessionId: locals.sessionId,
			state,
			code,
		});
		logger.info({ machine: done.machineName, server: done.server }, "mcp_local_oauth_callback_ok");
		back(done.next || home, "connected", undefined, done.connectorId);
	} catch (err) {
		// A `redirect` is thrown, so it must not be swallowed as a failure.
		if (err && typeof err === "object" && "status" in err && "location" in err) throw err;
		if (err instanceof LocalOauthError) {
			logger.warn({ detail: err.detail, message: err.message }, "mcp_local_oauth_callback_failed");
			back(home, "failed", err.detail);
		}
		logger.warn({ err }, "mcp_local_oauth_callback_failed");
		back(home, "failed", "exchange");
	}
};
