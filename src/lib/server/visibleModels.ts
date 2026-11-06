import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import {
	buildByokModels,
	ensureModelsFresh,
	defaultModel,
	models as sharedModels,
	type ProcessedModel,
} from "$lib/server/models";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { billToHeader } from "$lib/server/billTo";
import { isUnlistedForUsers } from "$lib/server/hiddenModels";

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
 * What this token's `/v1/models` says (the parsed body), or null if we could
 * not find out.
 *
 * Null and empty are different answers and the caller below treats them
 * differently: empty means the gateway said this person has no models, null
 * means we failed to ask.
 */
async function callerList(
	bearer: string,
	billingOrganization: string | undefined
): Promise<{ data?: { id?: unknown }[] } | null> {
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
		return (await response.json()) as { data?: { id?: unknown }[] };
	} catch (error) {
		logger.warn(error, "[models] Could not read the per-caller catalogue");
		return null;
	}
}

/** The ids in a per-caller body. */
function idsOf(json: { data?: { id?: unknown }[] }): Set<string> {
	return new Set(
		(json.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string")
	);
}

/** The billing group the person chose (ADR 0061), read from their settings. */
async function billingOrganizationOf(locals: Pick<App.Locals, "isAdmin" | "sessionId" | "user">) {
	const stored = await collections.settings.findOne(authCondition(locals), {
		projection: { billingOrganization: 1 },
	});
	return stored?.billingOrganization;
}

/**
 * The caller's own models (`my/<name>`, gateway BYOK), or null when the
 * gateway could not be asked. Derived from *their* `/v1/models` on every call
 * and never kept: the shared catalogue is built without a user token and a
 * private model must not outlive the request or reach another user. An
 * anonymous session (no token) has none.
 */
export async function callerByokModels(
	locals: Pick<App.Locals, "isAdmin" | "sessionId" | "token" | "user">
): Promise<ProcessedModel[] | null> {
	const bearer = locals.token;
	if (!bearer) return [];
	const json = await callerList(bearer, await billingOrganizationOf(locals));
	return json ? buildByokModels(json) : null;
}

/**
 * The models a turn for this caller may resolve a conversation's `modelId`
 * against: the shared catalogue, plus the caller's own models when the id is
 * a `my/` one. Another user's `my/x` is not in their list, so it resolves to
 * nothing for them. The gateway is only asked for a `my/` id.
 */
export async function modelsFor(
	locals: Pick<App.Locals, "isAdmin" | "sessionId" | "token" | "user">,
	modelId: string | undefined
): Promise<ProcessedModel[]> {
	if (!modelId?.startsWith("my/")) return sharedModels;
	return [...sharedModels, ...((await callerByokModels(locals)) ?? [])];
}

/**
 * Whether `id` is a model this caller may put on a conversation: a shared
 * catalogue id (as the caller's own check says), or one of their own `my/`
 * models. A `my/x` that is another user's, or whose capability was revoked, is
 * not in this caller's list and is refused. If the gateway cannot be asked,
 * a `my/` id is refused rather than guessed.
 */
export async function isSelectableCatalogueId(
	locals: Pick<App.Locals, "isAdmin" | "sessionId" | "token" | "user">,
	id: string,
	isCatalogueId: (id: string) => boolean
): Promise<boolean> {
	// An administrator-hidden model (or an unlisted one) is not newly selectable;
	// chats already on it keep working because they never pass through here.
	const known = sharedModels.find((model) => model.id === id);
	if (known && isUnlistedForUsers(known, defaultModel?.id)) return false;
	if (isCatalogueId(id)) return true;
	if (!id.startsWith("my/")) return false;
	return ((await callerByokModels(locals)) ?? []).some((model) => model.id === id);
}

export async function visibleModels(
	locals: Pick<App.Locals, "isAdmin" | "sessionId" | "token" | "user">
): Promise<ProcessedModel[]> {
	const catalogue = (await ensureModelsFresh()).filter(
		(model) => !isUnlistedForUsers(model, defaultModel?.id)
	);

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
	const json = await callerList(bearer, await billingOrganizationOf(locals));
	// **Falling back to the unfiltered list is deliberate.** If the gateway
	// could not be asked, showing everything is a slightly generous answer
	// that the gateway itself still refuses at send time; showing nothing
	// would tell somebody they have no models at all, which is the worse
	// lie and looks like their account has broken.
	if (!json) return catalogue;
	const reachable = idsOf(json);
	// The caller's own models are in their list and in no one else's, and not in
	// the shared catalogue (built without a token): add them here, per request.
	return [
		...catalogue.filter((model) => reachable.has(model.id)),
		...(await buildByokModels(json)),
	];
}
