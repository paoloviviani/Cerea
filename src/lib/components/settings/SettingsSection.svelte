<!--
	One settings card: the app's usual card, with an optional title, a pill
	before it, and a description. `active` tints the border the way
	`s.card(true)` does. 
	Part of the settings-page pattern; see `SettingsShell`.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import * as s from "$lib/components/overlay/styles";

	interface Props {
		/** Anchor id, for the shell's index. */
		id?: string;
		title?: string;
		/** A short badge before the title (a context level, say). */
		pill?: string;
		description?: string;
		active?: boolean;
		/** Beside the title, on the right (a link, say). */
		actions?: Snippet;
		/** Rendered as the card's `data-testid`. */
		testid?: string;
		children: Snippet;
	}

	let { id, title, pill, description, active = false, actions, children, testid }: Props = $props();
</script>

<section {id} class="{s.card(active)} scroll-mt-2" data-testid={testid}>
	<div class="p-4">
		{#if title}
			<div
				class="flex flex-wrap items-center justify-between gap-2 {description ? 'mb-1' : 'mb-3'}"
			>
				<h2 class="{s.SECTION_TITLE} mb-0">
					{#if pill}<span class="{s.PILL} {s.PILL_TONES.busy}">{pill}</span>{/if}
					{title}
				</h2>
				{#if actions}{@render actions()}{/if}
			</div>
			{#if description}<p class="mb-3 text-xs text-ink-muted">{description}</p>{/if}
		{:else if pill}
			<span class="{s.PILL} {s.PILL_TONES.busy} mb-2">{pill}</span>
		{/if}
		{@render children()}
	</div>
</section>
