<script lang="ts">
	import MarkdownRenderer from "./MarkdownRenderer.svelte";
	import BlockWrapper from "./BlockWrapper.svelte";
	import CarbonChevronRight from "~icons/carbon/chevron-right";

	interface Props {
		content: string;
		loading?: boolean;
		/** Whether the block is expanded. Bind it when the same reasoning is
		 * drawn by more than one branch of its parent (a message renders flat
		 * while it streams and nested once it ends, which mounts a new block):
		 * the parent keeps the state, so a block somebody opened stays open. */
		open?: boolean;
	}

	// Collapsed by default, streaming included: the shimmering header is the
	// live indicator, and the reader expands a section when they want to read it.
	let { content, loading = false, open = $bindable() }: Props = $props();
	const isOpen = $derived(open ?? false);
	// Reactive size bindings (powered by ResizeObserver under the hood) — used
	// to apply the fade mask only when the streamed content actually overflows
	// the viewport, so short reasoning isn't unnecessarily faded at the top.
	let viewportHeight = $state(0);
	let contentHeight = $state(0);
</script>

<BlockWrapper>
	<!-- Header row -->
	<button
		type="button"
		class="group/header flex w-fit cursor-pointer items-center gap-1 text-left select-none focus:outline-hidden"
		onclick={() => (open = !isOpen)}
		aria-label={isOpen ? "Collapse" : "Expand"}
	>
		<span
			class="text-sm font-medium transition-colors group-hover/header:text-gray-600 dark:group-hover/header:text-gray-300 {isOpen
				? 'text-gray-600 dark:text-gray-300'
				: 'text-gray-500 dark:text-gray-400'}"
			class:thinking-shimmer={loading}
		>
			Thinking
		</span>
		<CarbonChevronRight
			class="size-3.5 transition-all duration-200 group-hover/header:text-gray-600 dark:group-hover/header:text-gray-300 {isOpen
				? 'rotate-90 text-gray-600 dark:text-gray-300'
				: 'text-gray-400'}"
		/>
	</button>

	<!-- Expandable content -->
	{#if isOpen}
		{#if loading}
			<!--
				Streaming view: fixed-height viewport, content bottom-aligned so newly
				arriving tokens stay visible while older lines scroll off the top behind
				a gradient fade. Works for any model output format (no parsing).
			-->
			<div
				bind:clientHeight={viewportHeight}
				class="thinking-viewport mt-2 flex max-h-56 flex-col justify-end overflow-hidden md:max-h-80"
				class:has-overflow={contentHeight > viewportHeight}
			>
				<div
					bind:clientHeight={contentHeight}
					class="prose prose-sm max-w-none text-sm leading-relaxed text-gray-500 *:first:mt-0 *:last:mb-0 dark:text-gray-400 dark:prose-invert"
				>
					<MarkdownRenderer {content} {loading} />
				</div>
			</div>
		{:else}
			<div
				class="prose prose-sm mt-2 max-w-none text-sm leading-relaxed text-gray-500 dark:text-gray-400 dark:prose-invert"
			>
				<MarkdownRenderer {content} {loading} />
			</div>
		{/if}
	{/if}
</BlockWrapper>

<style>
	.thinking-viewport.has-overflow {
		-webkit-mask-image: linear-gradient(to bottom, transparent 0, black 48px);
		mask-image: linear-gradient(to bottom, transparent 0, black 48px);
	}
	/*
	 * Variant of router-shimmer (defined in main.css) — light mode inverted so
	 * the text reads dark with a brighter spot sweeping across, instead of
	 * medium-gray with darker edges. Dark mode keeps the same bright-spot
	 * behavior as router-shimmer.
	 */
	.thinking-shimmer {
		display: inline-block;
		background-image: linear-gradient(
			90deg,
			rgba(107, 114, 128, 1) 0%,
			rgba(107, 114, 128, 0.3) 50%,
			rgba(107, 114, 128, 1) 100%
		);
		background-size: 220% 100%;
		animation: router-shimmer 2.8s linear infinite;
		background-clip: text;
		-webkit-background-clip: text;
		color: transparent;
		-webkit-text-fill-color: transparent;
	}
	:global(.dark) .thinking-shimmer {
		background-image: linear-gradient(
			90deg,
			rgba(255, 255, 255, 0.15) 0%,
			rgba(255, 255, 255, 0.7) 50%,
			rgba(255, 255, 255, 0.15) 100%
		);
	}
</style>
