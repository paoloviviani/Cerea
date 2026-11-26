<script lang="ts">
	import type { MessageToolUpdate } from "$lib/types/MessageUpdate";
	import { isMessageToolCallUpdate, isMessageToolResultUpdate } from "$lib/utils/messageUpdates";
	import { ToolResultStatus } from "$lib/types/Tool";
	import { page } from "$app/state";
	import McpAppFrame from "./McpAppFrame.svelte";

	/**
	 * The MCP App page a tool call linked to (docs/dev/adr-mcp-apps.md), as its own block under the tool
	 * row. It is the result the user asked for, so it does not depend on the row being open, or on the
	 * row being visible at all (a run of rows folded into a summary shows it too). Only in a
	 * conversation: a shared link has no way to read the stored page and keeps the text result.
	 */
	interface Props {
		tool: MessageToolUpdate[];
	}

	let { tool }: Props = $props();

	const callUpdate = $derived(tool.find(isMessageToolCallUpdate));

	// An object argument is stored as JSON text (see toolParams.ts): the page gets the structure.
	const expandJsonText = (value: unknown): unknown => {
		if (typeof value !== "string" || !/^\s*[{[]/.test(value)) return value;
		try {
			const parsed: unknown = JSON.parse(value);
			return parsed !== null && typeof parsed === "object" ? parsed : value;
		} catch {
			return value;
		}
	};

	// The Call's own parameters, or the Result's where a transcript reached the card without the fold
	// that keeps the Call current (see ToolUpdate).
	const inputParameters = $derived.by(() => {
		const own = callUpdate?.call.parameters as Record<string, unknown> | undefined;
		if (own && Object.keys(own).length > 0) return own;
		const fromResult = tool.find(isMessageToolResultUpdate)?.result.call?.parameters as
			Record<string, unknown> | undefined;
		return fromResult && Object.keys(fromResult).length > 0 ? fromResult : own;
	});

	const appView = $derived.by(() => {
		const conversationId = page.params?.id;
		const result = tool.find(isMessageToolResultUpdate)?.result;
		if (!conversationId || !result || result.status !== ToolResultStatus.Success || !result.app) {
			return null;
		}
		const output = (result.outputs[0] ?? {}) as Record<string, unknown>;
		const text = typeof output["text"] === "string" ? output["text"] : "";
		const structured = output["structured"];
		const content = Array.isArray(output["content"]) ? output["content"] : [];
		let input: Record<string, unknown> = {};
		const raw = callUpdate?.argumentsRaw;
		if (typeof raw === "string") {
			try {
				const parsed: unknown = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					input = parsed as Record<string, unknown>;
				}
			} catch {
				// The card's own parameters stand in.
			}
		}
		if (Object.keys(input).length === 0 && inputParameters) {
			input = Object.fromEntries(
				Object.entries(inputParameters).map(([k, v]) => [k, expandJsonText(v)])
			);
		}
		return {
			app: result.app,
			conversationId,
			input,
			result: {
				content: content.length > 0 ? content : [{ type: "text", text }],
				...(structured && typeof structured === "object" && !Array.isArray(structured)
					? { structuredContent: structured as Record<string, unknown> }
					: {}),
			},
		};
	});
</script>

{#if appView}
	<McpAppFrame
		app={appView.app}
		conversationId={appView.conversationId}
		toolInput={appView.input}
		toolResult={appView.result}
	/>
{/if}
