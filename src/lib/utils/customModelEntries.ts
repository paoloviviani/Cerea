import type { GETModelsResponse } from "$lib/server/api/types";
import type { CustomModelView } from "$lib/types/CustomModel";

type ModelEntry = GETModelsResponse[number];

/**
 * A person's custom models as picker entries, built from the catalogue they
 * can see. Each is its base's entry with the id, name and description swapped:
 * capabilities (vision, tools, reasoning, artifacts), the router flag and the
 * accepted file types are copied, which is how the composer's gating and the
 * thinking-effort options carry over without a second code path.
 *
 * One whose base is not in `catalogue` is left out: there is nothing to run
 * it on, and the picker should not offer it. The Customize models tab lists it
 * from the API instead, marked unavailable.
 */
export function customModelEntries(
	views: Pick<CustomModelView, "id" | "name" | "description" | "baseModelId">[],
	catalogue: GETModelsResponse
): GETModelsResponse {
	const entries: GETModelsResponse = [];
	for (const view of views) {
		const base = catalogue.find((model) => model.id === view.baseModelId);
		if (!base) continue;
		entries.push({
			...base,
			id: view.id,
			name: view.name,
			displayName: view.name,
			description: view.description ?? base.description,
			// `preprompt` stays the base's: it is the deployment's prompt for that
			// model, which a conversation on it stores and the composer compares
			// against to decide whether to show a "system prompt" chip. The person's
			// own prompts are applied on the server and are not part of it.
			unlisted: false,
			customBase: { id: base.id, displayName: base.displayName },
		} satisfies ModelEntry);
	}
	return entries;
}

/** The id a per-model setting is keyed by: the base's, for a custom model. */
export function settingsModelId(model: { id: string; customBase?: { id: string } }): string {
	return model.customBase?.id ?? model.id;
}

/** "Menu helper · GLM 5.3 Flash" for a custom model, the plain name otherwise. */
export function modelLabel(model: {
	displayName?: string;
	name?: string;
	id: string;
	customBase?: { displayName: string };
}): string {
	const own = model.displayName ?? model.name ?? model.id;
	return model.customBase ? `${own} · ${model.customBase.displayName}` : own;
}
