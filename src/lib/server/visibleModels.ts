import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { ensureModelsFresh, type ProcessedModel } from "$lib/server/models";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { billToHeader } from "$lib/server/billTo";

/**
 * The catalogue models this caller may see: what `GET /api/v2/models` lists
 * and what a custom model's base is checked against. Lifted out of that route
 * so the two cannot disagree about what "the models you can see" means. See
 * the route's header for why the gateway stays the authority on access.
 *
 * A request is billed to the person's chosen billing group (ADR 0061), and
 * the gateway lists what that bill-to accepts — so the per-caller fetch
 * carries it too, or this list and the send path disagree for anyone in
 * more than one group (the models visible above, the turns refused below).
 */

/**
 * The ids this token can reach, or null if we could not find out.
 *
 * Null and empty are different answers and the caller below treats them
 * differently: empty means the gateway said this person has no models, null
 * means we failed to ask.
 */
async function reachableIds(
	bearer: string,
	billingOrganization: string | undefined
): Promise<Set<string> | null> {
	const base = config.OPENAI_BASE_URL?.replace(/\/$/, "");
	if (!base) return null;
	try {
		const response = await fetch(`${base}/models`, {
			headers: {
				Authorization: `Bearer ${bearer}`,
				// Which group pays for what the request would run, when the person
				// chose one (ADR 0061) — so the list is the list of what a turn
				// would accept. This fetch is only ever made with the person's
				// own OIDC token above; `x-bill-to` must not ride on anything
				// else (a key-authenticated call is refused for it), so no
				// header is added here when there is no token and no org.
				...billToHeader(billingOrganization),
			},
			// A page load is waiting on this. A gateway that has stopped
			// answering should degrade to the unfiltered list quickly rather
			// than hold the layout open until the platform's default timeout.
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) {
			logger.warn(
				{ status: response.status },
				"[models] Per-caller catalogue fetch refused; showing the unfiltered list"
			);
			return null;
		}
		const json = (await response.json()) as { data?: { id?: unknown }[] };
		const ids = (json.data ?? [])
			.map((entry) => entry.id)
			.filter((id): id is string => typeof id === "string");
		return new Set(ids);
	} catch (error) {
		logger.warn(error, "[models] Could not read the per-caller catalogue");
		return null;
	}
}

export async function visibleModels(
	locals: Pick<App.Locals, "isAdmin" | "sessionId" | "token" | "user">
): Promise<ProcessedModel[]> {
	const catalogue = (await ensureModelsFresh()).filter((model) => model.unlisted == false);

	// No OIDC token means there is nobody to filter *for* — an anonymous or
	// development session. It sees the deployment's list.
	const bearer = locals.token;
	if (!bearer) return catalogue;

	// The billing group the person chose (ADR 0061) lives in their settings,
	// not on the locals of every route that calls this — the conversation
	// turn route sets `locals.billingOrganization` for the endpoint's sends,
	// but a models listing has no such setter. Reading it here (once) means
	// every caller of `visibleModels` gets the same answer without each one
	// loading settings itself.
	const stored = await collections.settings.findOne(authCondition(locals), {
		projection: { billingOrganization: 1 },
	});
	const billingOrganization = stored?.billingOrganization;

	const reachable = await reachableIds(bearer, billingOrganization);
	// **Falling back to the unfiltered list is deliberate.** If the gateway
	// could not be asked, showing everything is a slightly generous answer
	// that the gateway itself still refuses at send time; showing nothing
	// would tell somebody they have no models at all, which is the worse
	// lie and looks like their account has broken.
	return reachable ? catalogue.filter((model) => reachable.has(model.id)) : catalogue;
}
