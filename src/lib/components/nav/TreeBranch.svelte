<!--
	One collapsible row in the sidebar tree.

	The whole left panel is a tree now: a disclosure triangle, a label, an
	optional count, an optional `+` that opens the thing's create dialog, and
	children that appear when it is open. Everything in the panel is one of
	these or a leaf inside one, which is what makes it read as a structure
	rather than as a pile of links.

	Two details that matter for the keyboard and for screen readers. By default
	the triangle and the label are **one button** — clicking the label expands,
	as it does in every file tree — and it carries `aria-expanded`, so the state
	is announced rather than only drawn. The `+` is a **separate** button beside
	it, because "add one of these" is a different action from "show me them",
	and nesting them would make one unreachable.

	Given an `href`, the label is a **link** instead, and the triangle becomes
	a button of its own ("Expand Projects" / "Collapse Projects", with
	`aria-expanded`): the two are different actions again, so each is its own
	tab stop. That is what the two top-level branches are, since each is a page
	(the list of projects, the list of chats) as well as a folder. Folders
	inside them keep the single button.

	The `+` is **always drawn**, not revealed on hover. Hover-to-reveal is
	invisible on a touch screen — there is no hover — so the only route to
	"new project" simply never appeared. It is muted instead, and darkens on
	hover and focus.
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
		/**
		 * Given, the label is a link to this address and only the triangle
		 * expands and collapses.
		 */
		href?: string;
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
		href,
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
		{#if href}
			<!-- The triangle's box is 20px so it can be hit; the negative margins
			     hand the extra 8px back, so the label sits where it does in a
			     branch that has no link. -->
			<button
				type="button"
				onclick={toggle}
				aria-expanded={open}
				aria-label="{open ? 'Collapse' : 'Expand'} {label}"
				title="{open ? 'Collapse' : 'Expand'} {label}"
				class="-mx-1 flex size-5 shrink-0 items-center justify-center rounded-md hover:bg-gray-200 dark:hover:bg-gray-600"
			>
				<CarbonChevronRight class="size-3 transition-transform {open ? 'rotate-90' : ''}" />
			</button>
			<a {href} class="flex min-w-0 flex-1 items-center gap-1.5 self-stretch pl-0.5">
				{#if icon}{@render icon()}{/if}
				<span class="min-w-0 truncate">{label}</span>
			</a>
		{:else}
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
		{/if}

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
				class="flex size-5 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-700 dark:hover:bg-gray-600 dark:hover:text-gray-200"
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
