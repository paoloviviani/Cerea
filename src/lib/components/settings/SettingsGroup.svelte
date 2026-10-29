<!--
	A heading with the settings cards that belong under it, and an optional
	one-line note. Part of the settings-page pattern; see `SettingsShell`.
-->
<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		/** Anchor id, for the shell's index. */
		id: string;
		title: string;
		/** One short line under the heading. */
		note?: string;
		children: Snippet;
	}

	let { id, title, note, children }: Props = $props();
</script>

<section {id} aria-labelledby="{id}-title" class="scroll-mt-2">
	<h2 id="{id}-title" class="text-base font-semibold text-ink">{title}</h2>
	{#if note}<p class="mt-0.5 text-xs text-ink-muted">{note}</p>{/if}
	<div class="mt-3 flex flex-col gap-4">
		{@render children()}
	</div>
</section>
