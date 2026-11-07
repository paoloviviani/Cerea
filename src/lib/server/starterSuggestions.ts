import { config } from "$lib/server/config";

/**
 * Whether the empty chat offers its four starter suggestions. Off unless the
 * administrator turned it on (Administration -> Assistant); a saved value wins
 * over the environment's `STARTER_SUGGESTIONS`, which is only the default.
 */
export function starterSuggestionsEnabled(): boolean {
	const raw = config.getSaved("STARTER_SUGGESTIONS") ?? config.STARTER_SUGGESTIONS;
	return raw === "true";
}
