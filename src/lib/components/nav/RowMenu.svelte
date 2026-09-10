<!--
	The `⋯` on a tree row, and what it offers.

	Managing one thing belongs on that thing's row, not behind a dialog listing
	all of them: reaching a project's Edit by opening an overlay, finding it in
	a list and clicking it is three steps to do something the row was already
	pointing at.

	It is **always drawn**, like the `+` beside it. Revealing it on hover made
	it invisible on a touch screen, where there is no hover — so Edit and
	Delete had no route at all — and hard to find with a pointer too. Muted,
	and it stays lit while its menu is open.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import CarbonOverflowMenuHorizontal from "~icons/carbon/overflow-menu-horizontal";

	interface Props {
		/** Names the row this menu belongs to, for screen readers. */
		label: string;
		children: Snippet<[() => void]>;
	}

	let { label, children }: Props = $props();

	let open = $state(false);
	let root: HTMLDivElement | undefined = $state();

	function onwindowclick(event: MouseEvent) {
		if (!open || !root) return;
		if (!root.contains(event.target as Node)) open = false;
	}

	function onwindowkeydown(event: KeyboardEvent) {
		if (event.key === "Escape" && open) open = false;
	}

	function close() {
		open = false;
	}
</script>

<svelte:window onclick={onwindowclick} onkeydown={onwindowkeydown} />

<div bind:this={root} class="relative shrink-0">
	<button
		type="button"
		onclick={(event) => {
			event.stopPropagation();
			open = !open;
		}}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="Manage {label}"
		title="Manage {label}"
		class="flex size-5 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-600 dark:hover:text-gray-200 {open
			? 'bg-gray-200 text-gray-700 dark:bg-gray-600 dark:text-gray-200'
			: ''}"
	>
		<CarbonOverflowMenuHorizontal class="size-3.5" />
	</button>

	{#if open}
		<div
			role="menu"
			class="absolute top-full right-0 z-30 mt-1 min-w-36 overflow-hidden rounded-lg border border-gray-200 bg-white py-0.5 shadow-lg dark:border-gray-600 dark:bg-gray-800"
		>
			<!-- The snippet is handed `close`, so an item can dismiss the menu
			     without each caller repeating the state. -->
			{@render children(close)}
		</div>
	{/if}
</div>
