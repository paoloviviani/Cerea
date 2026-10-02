/**
 * Whether this page may talk to /code at all right now — the one route under
 * `/api/v2/code/` the stale-session guard (`hooks/handle.ts`) lets through.
 *
 * It answers ONLY about the deployment and the caller's own sign-in:
 * `{enabled, fresh, reauthPath}` plus `freshUntil` (ISO) when fresh. Nothing
 * machine-derived, ever: no device names, no counts, no inbox badge. A stale
 * session learns exactly that it is stale and where to go; everything else
 * stays behind the guard.
 *
 * `reauthPath` is a same-origin path that sends the person through a forced
 * re-login and back to the panel (`reauth=1` makes the identity provider
 * authenticate again instead of answering from its own SSO session). It
 * already carries the app's base path and passes `sanitizeReturnPath`.
 */
import type { RequestHandler } from "@sveltejs/kit";
import { base } from "$app/paths";
import { codeAgentsEnabled } from "$lib/server/codeEnabled";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { authTimeFresh, freshUntil } from "$lib/server/code/stepUp";

export const GET: RequestHandler = ({ locals }) => {
	const fresh = Boolean(locals.user) && authTimeFresh(locals.authTime);
	return superjsonResponse(
		{
			enabled: codeAgentsEnabled(),
			fresh,
			reauthPath: `${base}/login?reauth=1&next=${base}/code`,
			...(fresh && locals.authTime
				? { freshUntil: freshUntil(locals.authTime).toISOString() }
				: {}),
		},
		{ headers: { "Cache-Control": "no-store" } }
	);
};
