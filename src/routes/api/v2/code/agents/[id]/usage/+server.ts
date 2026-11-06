/**
 * `GET /api/v2/code/agents/:id/usage?device=…[&sinceAgoMs=…[&untilAgoMs=…]]`:
 * what the gateway metered for this coding session (`sessionUsage.ts`), and
 * for one turn when the page says how long ago it began (and ended).
 *
 * Durations, not instants: the page's clock and the gateway's can differ, so
 * the page says "my last turn started 42 s ago" and this server turns that
 * into instants on its own clock.
 */

import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { getPairedDevice, requireCodeAgents } from "$lib/server/codeDevices";
import { sessionGatewayUsage } from "$lib/server/code/sessionUsage";

const DAY_MS = 86_400_000;

function ago(raw: string | null, now: number): Date | undefined {
	if (raw === null) return undefined;
	const ms = Number(raw);
	if (!Number.isFinite(ms) || ms < 0 || ms > 30 * DAY_MS) error(400, "Not a valid duration.");
	return new Date(now - ms);
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
	await requireCodeAgents(locals);
	const sessionId = params.id ?? "";
	if (!/^[A-Za-z0-9_.:~-]+$/.test(sessionId)) error(400, "Not a valid agent id.");
	await getPairedDevice(locals, url.searchParams.get("device"));
	if (!locals.token) return superjsonResponse({ available: false });

	const now = Date.now();
	const since = ago(url.searchParams.get("sinceAgoMs"), now);
	const until = ago(url.searchParams.get("untilAgoMs"), now);
	const usage = await sessionGatewayUsage(
		locals.token,
		sessionId,
		since ? { since, until } : undefined
	);
	return superjsonResponse(usage ? { available: true, ...usage } : { available: false });
};
