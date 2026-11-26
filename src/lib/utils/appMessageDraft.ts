import { getContext, setContext } from "svelte";

const KEY = "mcpAppMessageSink";

/**
 * What the chat does with a message an MCP App page proposes: show it as a suggestion above the composer.
 * Returns false when it is refused (too soon after the last one).
 */
export type AppMessageSink = (text: string, from: string) => boolean;

/** At most one suggestion this often: a page cannot flood the composer's surroundings. */
export const APP_SUGGESTION_INTERVAL_MS = 10_000;

/** Says whether a suggestion may be shown now, and counts it when it may. */
export function createSuggestionGate(now: () => number = Date.now): () => boolean {
	let last = -Infinity;
	return () => {
		const at = now();
		if (at - last < APP_SUGGESTION_INTERVAL_MS) return false;
		last = at;
		return true;
	};
}

export function setAppMessageSink(sink: AppMessageSink): void {
	setContext(KEY, sink);
}

export function getAppMessageSink(): AppMessageSink | undefined {
	return getContext<AppMessageSink | undefined>(KEY);
}

/** A page's proposed message is capped: it is a sentence for the user to read, not a payload. */
export const MAX_APP_MESSAGE_CHARS = 4000;
