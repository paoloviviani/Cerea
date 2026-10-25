<!--
	Renders a message that has markup in it, from its `.parts()`:

		{#snippet code(text: string)}<code class="font-mono">{text}</code>{/snippet}
		<Rich
			parts={m["settings.application.task_model.description"].parts({ name: "TASK_MODEL" })}
			tags={{ code }}
		/>

	Each `{#tag}…{/tag}` in the message is drawn by the snippet of the same
	name in `tags`. A tag with no snippet is drawn as its text, so a translation that adds
	one the template does not know degrades to plain words rather than failing.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import { richSegments, type MessagePartLike } from "./rich";

	interface Props {
		parts: readonly MessagePartLike[];
		/** Snippets named after the message's tags. */
		tags?: Record<string, Snippet<[string]>>;
	}

	let { parts, tags = {} }: Props = $props();

	const segments = $derived(richSegments(parts));
</script>

{#each segments as segment, index (index)}
	{@const render = segment.tag ? tags[segment.tag] : undefined}
	{#if render}
		{@render render(segment.text)}
	{:else}
		{segment.text}
	{/if}
{/each}
