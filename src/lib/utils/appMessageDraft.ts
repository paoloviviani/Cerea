import { getContext, setContext } from "svelte";

const KEY = "mcpAppMessageSink";

/** What the chat does with a message an MCP App page proposes: put it in the composer as a draft. */
export type AppMessageSink = (text: string, from: string) => void;

export function setAppMessageSink(sink: AppMessageSink): void {
	setContext(KEY, sink);
}

export function getAppMessageSink(): AppMessageSink | undefined {
	return getContext<AppMessageSink | undefined>(KEY);
}

/** A page's proposed message is capped: it is a sentence for the user to read, not a payload. */
export const MAX_APP_MESSAGE_CHARS = 4000;
