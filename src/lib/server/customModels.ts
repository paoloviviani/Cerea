import { ObjectId } from "mongodb";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { defaultModel, models, type ProcessedModel } from "$lib/server/models";
import {
	type CustomModel,
	type CustomModelView,
	CUSTOM_MODEL_MAX_PER_OWNER,
} from "$lib/types/CustomModel";
import { customModelId, customModelObjectId } from "$lib/utils/customModelId";

/**
 * Custom models on the server: who owns one, how a conversation's model id
 * becomes the model a turn runs on, and what the browser is shown.
 *
 * The one rule everything here serves: **the custom id never leaves Cerea.**
 * `resolveConversationModel` is where `custom:<id>` becomes a base model, and
 * every place that used to do `models.find(m => m.id === conv.model)` goes
 * through it, so the upstream request, the capability gates, the metrics and
 * the title all see the base.
 */

/** Who owns a row: a signed-in user, or an anonymous session. */
export type CustomModelOwner = Pick<App.Locals, "user" | "sessionId">;

/** The same filter `settings` uses, from the request's locals. */
export function ownerFilter(locals: CustomModelOwner): Filter {
	return authCondition(locals as App.Locals);
}

/**
 * The filter for a conversation's owner, which sweepers need because they run
 * with no request: the conversation carries `userId` or `sessionId`.
 */
export function conversationOwnerFilter(conv: {
	userId?: ObjectId;
	sessionId?: string;
}): Filter | undefined {
	if (conv.userId) return { userId: conv.userId };
	if (conv.sessionId) return { sessionId: conv.sessionId, userId: { $exists: false } };
	return undefined;
}

/** A Mongo filter that matches one owner's rows (`userId`, or `sessionId` with no user). */
export type Filter = Record<string, unknown>;

export async function listCustomModels(filter: Filter): Promise<CustomModel[]> {
	return collections.customModels
		.find(filter as never)
		.sort({ nameKey: 1 })
		.limit(CUSTOM_MODEL_MAX_PER_OWNER + 1)
		.toArray();
}

export async function findCustomModel(
	filter: Filter,
	id: string | undefined
): Promise<CustomModel | null> {
	const hex = customModelObjectId(id) ?? (id && /^[0-9a-f]{24}$/.test(id) ? id : undefined);
	if (!hex) return null;
	return collections.customModels.findOne({ _id: new ObjectId(hex), ...filter } as never);
}

export function customModelView(row: CustomModel): CustomModelView {
	return {
		id: customModelId(row._id.toString()),
		name: row.name,
		...(row.description ? { description: row.description } : {}),
		baseModelId: row.baseModelId,
		systemPrompt: row.systemPrompt,
	};
}

export interface ResolvedConversationModel {
	/** The catalogue model the turn runs on: always a base, never a custom one. */
	model: ProcessedModel;
	/** The custom model the conversation is on, when it still exists. */
	custom?: CustomModel;
	/** True when the conversation's model could not be honoured and the deployment default stands in. */
	fellBack: boolean;
}

/**
 * Turn a conversation's `model` into what a turn runs on.
 *
 * - a catalogue id resolves to itself, exactly as before (`undefined` when it
 *   is gone, so the callers keep their existing "no longer available" paths);
 * - a custom id resolves to its base, with the custom row so the caller can
 *   apply its prompt;
 * - a custom model that no longer exists, or whose base has left the
 *   catalogue, falls back to the deployment default instead of failing. (A
 *   deleted custom model's conversations are moved to its base when it is
 *   deleted, so this branch is the safety net: a row removed behind the app's
 *   back, an erased account's stray chat, a base retired from the gateway.)
 *   A custom model whose base is gone keeps its prompt on the default model:
 *   the person's instructions still stand.
 */
export async function resolveConversationModel(
	modelId: string,
	owner: Filter | undefined,
	catalogue: ProcessedModel[] = models
): Promise<ResolvedConversationModel | undefined> {
	const hex = customModelObjectId(modelId);
	if (!hex) {
		const model = catalogue.find((m) => m.id === modelId);
		return model ? { model, fellBack: false } : undefined;
	}
	const custom = owner ? await findCustomModel(owner, modelId) : null;
	const base = custom ? catalogue.find((m) => m.id === custom.baseModelId) : undefined;
	if (custom && base) return { model: base, custom, fellBack: false };
	const stand = defaultModel ?? catalogue[0];
	if (!stand) return undefined;
	return { model: stand, ...(custom ? { custom } : {}), fellBack: true };
}

/** The model id the outside world sees for a conversation's: the base's. */
export async function baseModelIdFor(modelId: string, owner: Filter | undefined): Promise<string> {
	if (!customModelObjectId(modelId)) return modelId;
	return (await resolveConversationModel(modelId, owner))?.model.id ?? modelId;
}

/**
 * Whether a model id may be put on a conversation by this caller: a catalogue
 * id as before, or one of their own custom models whose base is still there.
 * Another person's custom id is simply invalid.
 */
export async function isSelectableModel(
	modelId: string,
	owner: Filter | undefined,
	isCatalogueId: (id: string) => boolean
): Promise<boolean> {
	if (!customModelObjectId(modelId)) return isCatalogueId(modelId);
	const custom = owner ? await findCustomModel(owner, modelId) : null;
	return Boolean(custom && models.some((m) => m.id === custom.baseModelId));
}
