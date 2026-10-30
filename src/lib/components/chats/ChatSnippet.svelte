<!--
	The line under a chat's title on `/chats` when the chat was found by what
	was said in it: who said it, then a short stretch of the message with the
	matched words marked. The server cuts the snippet and says where the
	matches are (`contentSearch.ts`); this only draws it.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";

	interface Props {
		snippet: { text: string; spans: [number, number][]; from: "user" | "assistant" };
	}

	let { snippet }: Props = $props();

	const parts = $derived.by(() => {
		const out: { text: string; mark: boolean }[] = [];
		let at = 0;
		for (const [start, end] of snippet.spans) {
			if (start < at || end > snippet.text.length) continue;
			if (start > at) out.push({ text: snippet.text.slice(at, start), mark: false });
			out.push({ text: snippet.text.slice(start, end), mark: true });
			at = end;
		}
		if (at < snippet.text.length) out.push({ text: snippet.text.slice(at), mark: false });
		return out;
	});
</script>

<p class="mt-1 line-clamp-2 text-sm text-ink-muted" data-testid="chats-snippet">
	<span class="font-medium text-ink-faint"
		>{snippet.from === "user"
			? m["chat.list.snippet_user"]()
			: m["chat.list.snippet_assistant"]()}:</span
	>
	{#each parts as part, i (i)}{#if part.mark}<mark class="rounded-sm bg-accent/20 text-ink"
				>{part.text}</mark
			>{:else}{part.text}{/if}{/each}
</p>
