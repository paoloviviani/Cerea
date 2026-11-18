/**
 * How a coding engine is named in the Agents panel. galopin reports the engine
 * as the backend id of its session: `opencode`, or `acp:<name>` for an ACP agent
 * with the name the agent gave itself (goose says `goose`, Mistral Vibe says
 * `@mistralai/mistral-vibe`). The user sees a plain name, not the protocol id.
 */
const KNOWN: Record<string, { key: EngineKey; label: string }> = {
	opencode: { key: "opencode", label: "opencode" },
	goose: { key: "goose", label: "goose" },
	"@mistralai/mistral-vibe": { key: "vibe", label: "Mistral Vibe" },
	"mistral-vibe": { key: "vibe", label: "Mistral Vibe" },
	vibe: { key: "vibe", label: "Mistral Vibe" },
};

export type EngineKey = "opencode" | "goose" | "vibe" | "other";

function nameOf(provider: string): string {
	return provider.startsWith("acp:") ? provider.slice(4) : provider;
}

/** The engine's display name, or undefined when there is no provider. */
export function engineLabel(provider: string | undefined | null): string | undefined {
	if (!provider) return undefined;
	const name = nameOf(provider);
	return KNOWN[name.toLowerCase()]?.label ?? name;
}

/** Which icon the engine gets; "other" for an engine Cerea has no mark for. */
export function engineKey(provider: string | undefined | null): EngineKey {
	if (!provider) return "other";
	return KNOWN[nameOf(provider).toLowerCase()]?.key ?? "other";
}
