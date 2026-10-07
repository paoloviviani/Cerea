import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { ensureModelsFresh, type ProcessedModel } from "$lib/server/models";

/**
 * The catalogue models this caller may see: what `GET /api/v2/models` lists
 * and what a custom model's base is checked against. Lifted out of that route
 * so the two cannot disagree about what "the models you can see" means. See
 * the route's header for why the gateway stays the authority on access.
 */

/**
 * The ids this token can reach, or null if we could not find out.
 *
 * Null and empty are different answers and the caller below treats them
 * differently: empty means the gateway said this person has no models, null
 * means we failed to ask.
 */
async function reachableIds(bearer: string): Promise<Set<string> | null> {
	const base = config.OPENAI_BASE_URL?.replace(/\/$/, "");
	if (!base) return null;
	try {
		const response = await fetch(`${base}/models`, {
			headers: { Authorization: `Bearer ${bearer}` },
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

export async function visibleModels(locals: Pick<App.Locals, "token">): Promise<ProcessedModel[]> {
	const catalogue = (await ensureModelsFresh()).filter((model) => model.unlisted == false);

	// No OIDC token means there is nobody to filter *for* — an anonymous or
	// development session. It sees the deployment's list.
	const bearer = locals.token;
	if (!bearer) return catalogue;

	const reachable = await reachableIds(bearer);
	// **Falling back to the unfiltered list is deliberate.** If the gateway
	// could not be asked, showing everything is a slightly generous answer
	// that the gateway itself still refuses at send time; showing nothing
	// would tell somebody they have no models at all, which is the worse
	// lie and looks like their account has broken.
	return reachable ? catalogue.filter((model) => reachable.has(model.id)) : catalogue;
}
