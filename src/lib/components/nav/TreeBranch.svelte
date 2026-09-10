<!--
	One collapsible row in the sidebar tree.

	The whole left panel is a tree now: a disclosure triangle, a label, an
	optional count, an optional `+` that opens the thing's create dialog, and
	children that appear when it is open. Everything in the panel is one of
	these or a leaf inside one, which is what makes it read as a structure
	rather than as a pile of links.

	Two details that matter for the keyboard and for screen readers. The
	triangle and the label are **one button** — clicking the label expands, as
	it does in every file tree — and it carries `aria-expanded`, so the state is
	announced rather than only drawn. The `+` is a **separate** button beside
	it, because "add one of these" is a different action from "show me them",
	and nesting them would make one unreachable.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import CarbonAdd from "~icons/carbon/add";

	interface Props {
		label: string;
		/** Shown as a muted badge on the right — a count, usually. */
		badge?: string | number;
		open?: boolean;
		/** Indentation depth. 0 is a top-level branch. */
		depth?: number;
		/** Given, an `+` button appears and calls this. */
		onadd?: () => void;
		addTitle?: string;
		/** Given, the row itself acts on click instead of toggling. */
		onactivate?: () => void;
		icon?: Snippet;
		/** Row controls of the caller's own — a `⋯` menu, typically. */
		actions?: Snippet;
		children?: Snippet;
	}

	let {
		label,
		badge,
		open = $bindable(false),
		depth = 0,
		onadd,
		addTitle,
		onactivate,
		icon,
		actions,
		children,
	}: Props = $props();

	// A branch with no children snippet is a leaf: no triangle, and the row
	// activates rather than toggling. That keeps "MCP Servers" — which opens a
	// dialog and contains nothing — the same shape as its neighbours.
	const isLeaf = $derived(children === undefined);

	function toggle() {
		if (onactivate) {
			onactivate();
			return;
		}
		open = !open;
	}
</script>

<div class="flex flex-col">
	<div
		class="group flex h-8 items-center gap-1 rounded-lg pr-1 text-gray-500 hover:bg-gray-100 max-sm:h-10 dark:text-gray-400 dark:hover:bg-gray-700"
		style="padding-left: {0.25 + depth * 0.75}rem"
	>
		<button
			type="button"
			onclick={toggle}
			aria-expanded={isLeaf ? undefined : open}
			class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
		>
			{#if !isLeaf}
				<CarbonChevronRight
					class="size-3 shrink-0 transition-transform {open ? 'rotate-90' : ''}"
				/>
			{:else}
				<span class="size-3 shrink-0"></span>
			{/if}
			{#if icon}{@render icon()}{/if}
			<span class="min-w-0 truncate">{label}</span>
		</button>

		{#if badge !== undefined && badge !== ""}
			<span
				class="shrink-0 rounded-md bg-gray-500/5 px-1.5 py-0.5 text-xs text-gray-400 dark:bg-gray-500/20"
			>
				{badge}
			</span>
		{/if}

		{#if actions}{@render actions()}{/if}

		{#if onadd}
			<button
				type="button"
				onclick={onadd}
				title={addTitle ?? `New ${label.toLowerCase()}`}
				aria-label={addTitle ?? `New ${label.toLowerCase()}`}
				class="flex size-5 shrink-0 items-center justify-center rounded-md text-gray-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-gray-200 focus:opacity-100 dark:hover:bg-gray-600"
			>
				<CarbonAdd class="size-3.5" />
			</button>
		{/if}
	</div>

	{#if open && children}
		<div class="flex flex-col gap-px">
			{@render children()}
		</div>
	{/if}
</div>
