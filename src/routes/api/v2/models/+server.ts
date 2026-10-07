import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { serializeModelSummary } from "$lib/server/api/utils/serializeModel";
import type { GETModelsResponse } from "$lib/server/api/types";
import { logger } from "$lib/server/logger";
import { visibleModels } from "$lib/server/visibleModels";

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

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const shown = await visibleModels(locals);
		return superjsonResponse(shown.map(serializeModelSummary) satisfies GETModelsResponse, {
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
