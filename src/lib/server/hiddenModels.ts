import { config } from "$lib/server/config";

/**
 * Models an administrator hid from users (Administration -> Assistant ->
 * Models hidden from the chat picker). A hidden model is "unlisted" as far as
 * users are concerned: it is not offered in any picker and cannot be newly
 * chosen. It stays in the registry, so internal callers (titles) and chats
 * already on it keep working.
 */
export function parseHiddenModels(raw: string | undefined | null): string[] {
	return [
		...new Set(
			(raw ?? "")
				.split(/[,\n]/)
				.map((s) => s.trim())
				.filter(Boolean)
		),
	];
}

/** The ids saved by the administrator, else the HIDDEN_MODELS environment value. */
export function hiddenModelIds(): string[] {
	return parseHiddenModels(config.getSaved("HIDDEN_MODELS") ?? config.HIDDEN_MODELS);
}

/**
 * Whether users must not be offered this model: unlisted in the registry
 * (environment override) or hidden by an administrator. The default model is
 * never treated as hidden, whatever is stored: users fall back to it.
 */
export function isUnlistedForUsers(
	model: { id: string; unlisted?: boolean },
	defaultId?: string
): boolean {
	if (model.unlisted) return true;
	if (defaultId && model.id === defaultId) return false;
	return hiddenModelIds().includes(model.id);
}
