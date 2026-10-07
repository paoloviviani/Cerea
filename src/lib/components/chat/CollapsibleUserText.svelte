<!--
	A user message: right-aligned in a tinted bubble, so a fast scroll tells
	the person's turns from the replies (which sit left, in a neutral bubble)
	by position alone. Folded when it is long: a pasted log or document would
	otherwise push the conversation off screen. Clipped at a fixed height, with
	a fade and "Show more"; the full text is always in the DOM, so copy and
	find-in-page still see every word.
-->
<script lang="ts">
	interface Props {
		text: string;
		class?: string;
	}

	let { text, class: className = "" }: Props = $props();

	/** About twelve lines of body text. */
	const COLLAPSED_PX = 288;

	let el = $state<HTMLParagraphElement>();
	let expanded = $state(false);
	let overflows = $state(false);

	$effect(() => {
		const node = el;
		if (!node) return;
		// Re-measured on resize: a phone rotating or a pane opening changes how
		// many lines the same text takes.
		const measure = () => {
			overflows = node.scrollHeight > COLLAPSED_PX + 24;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	});
</script>

<div class="flex w-full flex-col items-end">
	<div
		class="relative w-fit max-w-[85%] overflow-hidden rounded-[1.1rem] bg-blue-50 dark:bg-accent-subtle"
	>
		<p
			bind:this={el}
			class={className}
			style:max-height={overflows && !expanded ? `${COLLAPSED_PX}px` : undefined}
			style:overflow={overflows && !expanded ? "hidden" : undefined}
		>
			{text}
		</p>
		{#if overflows && !expanded}
			<div
				class="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-blue-50 dark:from-accent-subtle"
			></div>
		{/if}
	</div>
	{#if overflows}
		<button
			type="button"
			class="mt-1 mr-2 mb-2 text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
			aria-expanded={expanded}
			onclick={() => (expanded = !expanded)}
		>
			{expanded ? "Show less" : "Show more"}
		</button>
	{/if}
</div>
