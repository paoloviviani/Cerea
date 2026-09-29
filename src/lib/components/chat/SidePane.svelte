<script lang="ts">
	import type { Snippet } from "svelte";
	import { fade, fly } from "svelte/transition";
	import { cubicOut } from "svelte/easing";
	import CarbonClose from "~icons/carbon/close";

	import { sidePane, SIDE_PANE_DEFAULT_FRACTION } from "$lib/stores/sidePane.svelte";
	import { useIsDesktop } from "$lib/utils/isDesktop.svelte";

	interface Props {
		/** Accessible name for the pane, e.g. "Artifact panel". */
		label: string;
		/**
		 * Suppresses Escape-to-close while the view has something more urgent bound
		 * to it (a modal of its own, an in-flight generation).
		 */
		escapeDisabled?: boolean;
		/**
		 * The view's own header/body/footer. Receives `resizing` so it can make
		 * iframes pointer-events-none mid-drag — otherwise the frame swallows the
		 * pointer and the drag dies as soon as it crosses into the content.
		 */
		children: Snippet<[boolean]>;
		/**
		 * Opt-in frame header: a title, the view's `actions`, and the pane's close
		 * button. Views that draw their own header (the artifact panel, with its
		 * version and tab controls) leave this unset.
		 */
		title?: string;
		actions?: Snippet;
	}

	let { label, escapeDisabled = false, children, title, actions }: Props = $props();

	/**
	 * The shared frame every side-pane view sits in: a resizable column beside the
	 * chat on desktop, a fullscreen overlay on mobile. Views gate their own
	 * mounting on `sidePane.view`, so only one of them is ever rendered here.
	 */
	const isDesktop = useIsDesktop();

	let resizing = $state(false);
	let asideEl: HTMLElement | undefined = $state();

	function onResizeStart(e: PointerEvent) {
		resizing = true;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onResizeMove(e: PointerEvent) {
		if (!resizing) return;
		// Clamp against the live chat/pane split (each pane keeps >= 20%) so the
		// drag tracks the pointer 1:1 with no dead zone at the bounds.
		const total = asideEl?.parentElement?.clientWidth ?? window.innerWidth;
		const raw = window.innerWidth - e.clientX;
		sidePane.setWidth(Math.min(Math.max(raw, Math.max(total * 0.2, 300)), total * 0.8));
	}
	function onResizeEnd() {
		resizing = false;
	}

	function handleKeydown(e: KeyboardEvent) {
		// An Escape already consumed by a modal (external-link confirm, fullscreen
		// preview) must not also close the pane
		if (e.defaultPrevented) return;
		if (e.key === "Escape" && sidePane.open && !escapeDisabled) {
			e.preventDefault();
			sidePane.close();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#snippet frameHeader(heading: string)}
	<header
		class="flex h-11 flex-none items-center gap-2 border-b border-gray-100 px-3 dark:border-gray-800"
		data-testid="side-pane-header"
	>
		<h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{heading}</h2>
		{@render actions?.()}
		<button
			type="button"
			class="flex size-7 flex-none items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
			aria-label="Close {label}"
			title="Close (Esc)"
			onclick={() => sidePane.close()}
		>
			<CarbonClose class="size-4" />
		</button>
	</header>
{/snippet}

{#if isDesktop.current}
	<aside
		bind:this={asideEl}
		class="pointer-events-auto relative z-10 my-1.5 flex h-[calc(100%-0.75rem)] flex-none flex-col overflow-hidden rounded-l-xl border border-r-0 border-gray-100 bg-linear-to-r from-gray-50 to-white shadow-[-1px_0_12px_-6px_rgba(0,0,0,0.08)] dark:border-transparent dark:from-gray-800/30 dark:to-gray-900 dark:shadow-none"
		style="width: {sidePane.widthPx !== null
			? `${sidePane.widthPx}px`
			: SIDE_PANE_DEFAULT_FRACTION}; min-width: max(20%, 300px); max-width: 80%;"
		aria-label={label}
	>
		<!-- resize handle (drag to resize, double-click to reset): an invisible
		     hit zone; the grip pill shows on hover and turns blue mid-drag -->
		<div
			role="separator"
			aria-orientation="vertical"
			class="group absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize transition-colors"
			onpointerdown={onResizeStart}
			onpointermove={onResizeMove}
			onpointerup={onResizeEnd}
			onpointercancel={onResizeEnd}
			ondblclick={() => sidePane.resetWidth()}
		>
			<span
				class="pointer-events-none absolute top-1/2 left-0.5 h-8 w-1 -translate-y-1/2 rounded-full {resizing
					? 'bg-blue-500/60 opacity-100'
					: 'bg-gray-300 opacity-0 group-hover:opacity-100 dark:bg-gray-600'}"
				data-testid="side-pane-grip"
			></span>
		</div>
		{#if title}
			{@render frameHeader(title)}
			<div class="flex min-h-0 flex-1 flex-col">
				{@render children(resizing)}
			</div>
		{:else}
			{@render children(resizing)}
		{/if}
	</aside>
{:else}
	<!-- Below desktop this is a drawer, and deliberately the *same* drawer the
	     navigation uses at the other edge: 85% of the width, a fading black/30
	     backdrop that closes on tap, rounded and shadowed on the side it comes
	     from. It used to be a bare `fixed inset-0` panel that simply appeared,
	     which made one app look like two — the chat list slid, this did not.
	     The nav drawer animates with a spring because it is always mounted and
	     merely translated off-screen; this one is mounted only while open, so
	     it uses the fly/fade pair (Modal.svelte's easing and duration) which
	     can also animate on the way out. Matching the motion matters more than
	     matching the mechanism. Not carried over: the nav's drag-to-close
	     gesture, which is bound to its own edge zone. -->
	<!-- `pointer-events-auto` is load-bearing and was missing: the chat column
	     this renders inside is `pointer-events-none` (it sits under the
	     composer's stacking context), so without it every tap on the backdrop
	     went straight through to the page and the drawer could only be closed
	     from its own header — the one thing a backdrop exists to fix. -->
	<button
		type="button"
		class="pointer-events-auto fixed inset-0 z-20 cursor-default bg-black/30"
		transition:fade|local={{ easing: cubicOut, duration: 300 }}
		onclick={() => sidePane.close()}
		aria-label="Close {label}"
	></button>
	<div
		class="pointer-events-auto fixed top-0 right-0 bottom-0 z-30 flex max-h-dvh w-[85%] flex-col
			overflow-hidden rounded-l-xl bg-white shadow-[-5px_0_15px_0_rgba(0,0,0,0.3)] dark:bg-gray-900"
		transition:fly|local={{ x: "100%", easing: cubicOut, duration: 300 }}
		role="dialog"
		aria-label={label}
	>
		{#if title}
			{@render frameHeader(title)}
			<div class="flex min-h-0 flex-1 flex-col">
				{@render children(false)}
			</div>
		{:else}
			{@render children(false)}
		{/if}
	</div>
{/if}
