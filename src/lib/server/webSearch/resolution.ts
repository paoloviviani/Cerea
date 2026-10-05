/**
 * Which search backend a caller's web search runs on, resolved the same way
 * everywhere it is asked: the admin screen shows it, the chat's tool sends it.
 *
 * Priority, highest first:
 *
 * 1. **An env value** (`WEB_SEARCH_MODEL`) — the operator who named one means
 *    it; shown read-only on the screen.
 * 2. **The Web search screen's stored choice** — an administrator's decision.
 * 3. **Nothing named**: the search goes to the gateway without a backend and
 *    the caller's billing-group search policy decides.
 *
 * A configured name only counts when this caller is granted it (`granted` is
 * `/v1/models?include=search` with the caller's token): an ungranted choice
 * degrades to the policy rather than failing the search, and the admin screen
 * says so (`stale`).
 */

export type WebSearchSource = "env" | "stored" | "policy";

export interface WebSearchResolution {
	/** The backend to name to the gateway, or null to let the group policy decide. */
	model: string | null;
	source: WebSearchSource;
	/** A choice exists but this caller is not granted it. */
	stale: boolean;
	/** The caller has at least one granted search backend: web search can work. */
	available: boolean;
}

export function resolveWebSearch(options: {
	envModel: string | null;
	storedModel: string | null;
	granted: string[];
}): WebSearchResolution {
	const { envModel, storedModel, granted } = options;
	const available = granted.length > 0;
	const choice = envModel ? { name: envModel, source: "env" as const } : null;
	const chosen = choice ?? (storedModel ? { name: storedModel, source: "stored" as const } : null);
	if (!chosen) return { model: null, source: "policy", stale: false, available };
	if (granted.includes(chosen.name)) {
		return { model: chosen.name, source: chosen.source, stale: false, available };
	}
	return { model: null, source: chosen.source, stale: true, available };
}
