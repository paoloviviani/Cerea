/**
 * Which model in a provider's list is "active" for a session: the session's
 * explicit model when the list still carries it, else the list's own
 * default — never a stale fallback across the two, so a removed explicit
 * choice reads as "not in the list" (nothing matches) rather than silently
 * landing on the default. Ids are matched exactly as given: a
 * provider-prefixed id (`pystino/glm-5.3-flash`) and a bare one
 * (`glm-5.3-flash`) are different ids, and the caller is responsible for
 * passing the same form the list uses.
 */
export interface ActiveModelCandidate {
	id: string;
	isDefault?: boolean;
}

export function resolveActiveModel<T extends ActiveModelCandidate>(
	modelId: string | null | undefined,
	models: T[] | null | undefined
): T | undefined {
	if (modelId) return models?.find((model) => model.id === modelId);
	return models?.find((model) => model.isDefault);
}
