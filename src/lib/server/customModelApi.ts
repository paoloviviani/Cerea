import { error } from "@sveltejs/kit";
import { z } from "zod";
import { visibleModels } from "$lib/server/visibleModels";
import {
	CUSTOM_MODEL_DESCRIPTION_MAX,
	CUSTOM_MODEL_NAME_MAX,
	CUSTOM_MODEL_PROMPT_MAX,
} from "$lib/types/CustomModel";
import { isCustomModelId } from "$lib/utils/customModelId";

/** Shared by the custom-models routes; a `+server.ts` may not export helpers. */

export const customModelFields = {
	name: z.string().trim().min(1, "Give it a name.").max(CUSTOM_MODEL_NAME_MAX),
	baseModelId: z.string().min(1, "Pick a base model."),
	systemPrompt: z.string().trim().min(1, "Write a system prompt.").max(CUSTOM_MODEL_PROMPT_MAX),
	// `null` or empty means none: the form always sends the field, so that an
	// edit can clear it, and a create with it empty sends the same null.
	description: z.string().trim().max(CUSTOM_MODEL_DESCRIPTION_MAX).nullish(),
};

/** The base must be a catalogue model this person can see — never another custom model. */
export async function assertBaseModel(locals: App.Locals, baseModelId: string) {
	if (isCustomModelId(baseModelId)) error(400, "A custom model cannot be based on another one.");
	const visible = await visibleModels(locals);
	if (!visible.some((model) => model.id === baseModelId)) {
		error(400, "That base model is not available to you.");
	}
}

export function isDuplicateKey(err: unknown): boolean {
	return err instanceof Error && /duplicate key|E11000/i.test(err.message);
}
