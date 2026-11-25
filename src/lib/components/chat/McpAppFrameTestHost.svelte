<script lang="ts">
	// Test host: supplies the composer's message sink the way ChatWindow does.
	import McpAppFrame from "./McpAppFrame.svelte";
	import { setAppMessageSink } from "$lib/utils/appMessageDraft";
	import type { ComponentProps } from "svelte";

	type Props = ComponentProps<typeof McpAppFrame>;
	let {
		sink,
		app,
		conversationId,
		toolInput,
		toolResult,
		pageUrl,
	}: { sink: (text: string, from: string) => boolean } & Props = $props();

	setAppMessageSink((text, from) => sink(text, from));
</script>

<McpAppFrame {app} {conversationId} {toolInput} {toolResult} {pageUrl} />
