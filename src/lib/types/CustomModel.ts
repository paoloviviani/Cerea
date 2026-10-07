import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * A person's own named variant of a catalogue model: a base model plus a
 * system prompt, chosen like any other model in the picker.
 *
 * **Private, and keyed the way `Settings` is.** One of `userId` (signed in) or
 * `sessionId` (anonymous) owns a row, matched through `authCondition`. Nobody
 * else can read, change or delete it, and it is erased with the account
 * (`userKeyedCollections.ts`).
 *
 * **A custom model is never sent anywhere.** Cerea resolves it to
 * `baseModelId` on every turn; the upstream request names the base model, and
 * the custom id exists only in Cerea (`conversation.model`, the picker).
 */
export interface CustomModel extends Timestamps {
	_id: ObjectId;
	userId?: User["_id"];
	sessionId?: string;
	/** What the person called it, as typed (trimmed). */
	name: string;
	/** `name`, lower-cased: the per-owner uniqueness key. */
	nameKey: string;
	/** A catalogue model id. Never another custom model. */
	baseModelId: string;
	systemPrompt: string;
	description?: string;
}

/** What the API sends the browser. */
export interface CustomModelView {
	id: string;
	name: string;
	description?: string;
	baseModelId: string;
	systemPrompt: string;
}

export const CUSTOM_MODEL_NAME_MAX = 60;
export const CUSTOM_MODEL_DESCRIPTION_MAX = 160;
export const CUSTOM_MODEL_PROMPT_MAX = 20_000;
export const GLOBAL_SYSTEM_PROMPT_MAX = 20_000;
/** A person's list is a handful of variants, not a catalogue. */
export const CUSTOM_MODEL_MAX_PER_OWNER = 50;
