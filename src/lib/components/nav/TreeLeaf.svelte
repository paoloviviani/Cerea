<!--
	A leaf in the sidebar tree: one model, one base, one chat.

	A link when it has an `href`, a button when it has an action, because a
	conversation is an address and opening a dialog is not. Both draw the same,
	so the tree reads as one thing whichever it is.
-->
<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		label: string;
		href?: string;
		onclick?: () => void;
		/** Indentation depth, matching `TreeBranch`. */
		depth?: number;
		/** Drawn as the current item. */
		active?: boolean;
		title?: string;
		icon?: Snippet;
		trailing?: Snippet;
	}

	let { label, href, onclick, depth = 1, active = false, title, icon, trailing }: Props = $props();

	const shell = $derived(
		[
			"group flex h-8 items-center gap-1.5 rounded-lg pr-1 text-sm max-sm:h-10",
			active
				? "bg-accent-subtle font-medium text-accent"
				: "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700",
		].join(" ")
	);
	const pad = $derived(`padding-left: ${0.25 + depth * 0.75 + 0.75}rem`);
</script>

{#if href}
	<a {href} {title} {onclick} class="{shell} no-underline" style={pad}>
		{#if icon}{@render icon()}{/if}
		<span class="min-w-0 flex-1 truncate">{label}</span>
		{#if trailing}{@render trailing()}{/if}
	</a>
{:else}
	<button type="button" {title} {onclick} class="{shell} text-left" style={pad}>
		{#if icon}{@render icon()}{/if}
		<span class="min-w-0 flex-1 truncate">{label}</span>
		{#if trailing}{@render trailing()}{/if}
	</button>
{/if}
