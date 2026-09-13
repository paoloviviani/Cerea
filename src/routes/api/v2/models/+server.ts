import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { serializeModelSummary } from "$lib/server/api/utils/serializeModel";
import type { GETModelsResponse } from "$lib/server/api/types";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";

/**
 * The models this caller may actually use.
 *
 * This endpoint is the single place the application learns what to offer:
 * `+layout.ts` fills `data.models` from it, and the Models dialog, the composer
 * and the per-conversation picker all read that. So it is also the single place
 * worth fixing, and both halves of the fix are here.
 *
 * **It used to be a deployment-wide snapshot taken at boot**, which produced two
 * symptoms nobody could reconcile from the outside:
 *
 * * a model granted to one group appeared for *everyone*, because the
 *   catalogue was fetched with `OPENAI_API_KEY`, a deployment credential, rather
 *   than with the token of the person reading it. Choosing one answered 404 at
 *   send time.
 *
 * One defect, two symptoms. `ensureModelsFresh` addresses the first — the
 * catalogue is rebuilt when stale rather than only at boot. The per-caller
 * filter below addresses the second.
 *
 * **The gateway stays the authority on access.** This filter decides what to
 * *show*; the gateway decides what is permitted, and still refuses. That is
 * deliberate: a second access-control answer in this application means two
 * sources that agree until they do not, and the one that is wrong is the one
 * nobody thinks to check.
 */

// Short, and private. The list is per-caller now, so a shared cache would be a
// way to serve one person's models to another.
const MODELS_CACHE_HEADERS = { "Cache-Control": "private, max-age=60" };

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

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const { ensureModelsFresh } = await import("$lib/server/models");
		const catalogue = (await ensureModelsFresh()).filter((model) => model.unlisted == false);

		// No OIDC token means there is nobody to filter *for* — an anonymous or
		// development session. It sees the deployment's list, which is what
		// every session saw before this endpoint learned to filter at all.
		const bearer = locals.token;
		if (!bearer) {
			return superjsonResponse(catalogue.map(serializeModelSummary) satisfies GETModelsResponse, {
				headers: MODELS_CACHE_HEADERS,
			});
		}

		const reachable = await reachableIds(bearer);
		// **Falling back to the unfiltered list is deliberate.** If the gateway
		// could not be asked, showing everything is a slightly generous answer
		// that the gateway itself still refuses at send time; showing nothing
		// would tell somebody they have no models at all, which is the worse
		// lie and looks like their account has broken.
		const shown = reachable ? catalogue.filter((model) => reachable.has(model.id)) : catalogue;

		const summaries = shown.map(serializeModelSummary);

		return superjsonResponse(summaries satisfies GETModelsResponse, {
			headers: MODELS_CACHE_HEADERS,
		});
	} catch (error) {
		// Unchanged in shape from before: an empty array rather than a 500,
		// because the layout load treats this as best-effort and a failure here
		// should not blank the application. Logged now, where it was silent.
		logger.error(error, "[models] Could not serve the catalogue");
		return superjsonResponse([] as GETModelsResponse);
	}
};
