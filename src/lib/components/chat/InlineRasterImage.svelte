<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { filePreviewMimeType, fileExtensionOf } from "$lib/utils/filePreview";

	/**
	 * A raster image shown under a file card without a click (the chat figure
	 * capture). The caller has already decided the file qualifies
	 * (`isInlineRasterImage`); this only fetches the bytes once and shows them
	 * from a blob URL typed by the file's extension. A failed fetch is a line
	 * of text — the card's download stays the way to the file.
	 */
	interface Props {
		name: string;
		load: () => Promise<ArrayBuffer | Uint8Array<ArrayBuffer>>;
	}

	let { name, load }: Props = $props();

	let url = $state<string | null>(null);
	let busy = $state(true);
	let failure = $state<string | null>(null);
	let gone = false;

	onMount(() => {
		void (async () => {
			try {
				const data = await load();
				if (gone) return;
				url = URL.createObjectURL(
					new Blob([data], { type: filePreviewMimeType(fileExtensionOf(name)) })
				);
			} catch (err) {
				failure =
					err instanceof Error
						? err.message
						: "the preview is unavailable; the download still works";
			} finally {
				busy = false;
			}
		})();
	});

	onDestroy(() => {
		gone = true;
		if (url) URL.revokeObjectURL(url);
	});
</script>

{#if busy}
	<p class="text-xs text-gray-400">Loading preview…</p>
{:else if failure}
	<p class="text-xs text-amber-600 dark:text-amber-400">{failure}</p>
{:else if url}
	<img
		src={url}
		alt={`Preview of ${name}`}
		class="scrollbar-custom max-h-80 w-full overflow-auto rounded-lg object-contain"
	/>
{/if}
