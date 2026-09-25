import type { Conversation } from "$lib/types/Conversation";
import type { Settings } from "$lib/types/Settings";
import { isMlAssistantConversation } from "$lib/server/mlAssistant";
import { ML_ASSISTANT_EFFORT } from "$lib/constants/mlAssistant";

/**
 * The thinking effort a turn goes out at, for a model that takes one: the
 * ML Assistant preset's own, else what this conversation chose, else the
 * user's per-model default, else nothing (the model's own default). One
 * resolver for every place that starts a turn, so they cannot disagree.
 */
export function effectiveReasoningEffort(
	conv: Pick<Conversation, "reasoningEffort" | "mlAssistant">,
	settings: Pick<Settings, "reasoningEffortOverrides"> | null | undefined,
	modelId: string
): "low" | "medium" | "high" | undefined {
	if (isMlAssistantConversation(conv)) return ML_ASSISTANT_EFFORT;
	return conv.reasoningEffort ?? settings?.reasoningEffortOverrides?.[modelId];
}
