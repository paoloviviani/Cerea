<script lang="ts">
	import type { PreviewSlide } from "$lib/utils/pptxPreview";

	/**
	 * The slides of a deck drawn in the browser (`$lib/utils/pptxPreview`), one
	 * image per slide. Each is an `<img>` on a data: URL — the SVG that came out
	 * of a user's file is never put in the page as markup, so nothing in it can
	 * run or load anything.
	 */
	interface Props {
		title: string;
		slides: PreviewSlide[];
		/** "Approximate rendering" note, when the library reported unsupported features. */
		note?: string | null;
		details?: string[];
	}

	let { title, slides, note = null, details = [] }: Props = $props();
</script>

<div
	class="scrollbar-custom flex h-full flex-col gap-3 overflow-y-auto bg-gray-50 p-3 dark:bg-gray-900"
	data-testid="pptx-slides"
>
	{#if note}
		<p
			class="rounded-lg border border-amber-300/60 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
			data-testid="pptx-approximate"
			title={details.join("\n")}
		>
			{note}
		</p>
	{/if}
	{#each slides as slide (slide.number)}
		<img
			src={slide.src}
			alt={`${title}, slide ${slide.number}`}
			class="w-full flex-none rounded-md border border-gray-200 bg-white shadow-xs dark:border-gray-700"
			loading="lazy"
			decoding="async"
		/>
	{/each}
</div>
