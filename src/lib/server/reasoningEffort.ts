import type { Conversation } from "$lib/types/Conversation";
import type { Settings } from "$lib/types/Settings";

/**
 * The thinking effort a turn goes out at, for a model that takes one: the
 * what this conversation chose, else the user's per-model default, else
 * nothing (the model's own default). One
 * resolver for every place that starts a turn, so they cannot disagree.
 */
export function effectiveReasoningEffort(
	conv: Pick<Conversation, "reasoningEffort">,
	settings: Pick<Settings, "reasoningEffortOverrides"> | null | undefined,
	modelId: string
): "low" | "medium" | "high" | undefined {
	return conv.reasoningEffort ?? settings?.reasoningEffortOverrides?.[modelId];
}
