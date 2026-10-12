<script lang="ts">
	/**
	 * The composer's pending attachments as removable chips, above the input —
	 * chat's strip, for any composer that keeps a bindable `File[]` (see
	 * `$lib/utils/composerFiles`). Previews are the files' own bytes (base64),
	 * so nothing is fetched before the message is sent.
	 *
	 * `compact` renders a left-aligned strip of small thumbnails: the mode the
	 * agent composer uses, where the strip sits in its own row above the
	 * input. An image preview at the full chip size inside that composer's
	 * single row is what squeezed the textarea to a sliver.
	 */
	import { fly } from "svelte/transition";
	import { cubicInOut } from "svelte/easing";
	import type { MessageFile } from "$lib/types/Message";
	import file2base64 from "$lib/utils/file2base64";
	import UploadedFile from "./UploadedFile.svelte";
	import IconClose from "~icons/carbon/close";

	interface Props {
		files: File[];
		/** Hide the strip (chat hides it while a reply is generating). */
		hidden?: boolean;
		/** Small thumbnails, left-aligned, images as tiles. */
		compact?: boolean;
	}

	let { files = $bindable([]), hidden = false, compact = false }: Props = $props();

	let sources = $derived(
		files?.map<Promise<MessageFile>>((file) =>
			file2base64(file).then((value) => ({
				type: "base64",
				value,
				mime: file.type,
				name: file.name,
			}))
		)
	);

	const drop = (index: number) => {
		files = files.filter((_, i) => i !== index);
	};
</script>

{#if sources?.length && !hidden}
	<div
		in:fly|local={sources.length === 1 ? { y: -20, easing: cubicInOut } : undefined}
		class="flex flex-row flex-wrap gap-2.5 rounded-xl pb-3 {compact
			? 'justify-start'
			: 'justify-center'}"
	>
		{#each sources as source, index}
			{#await source then src}
				{#if compact && src.mime.startsWith("image/")}
					<!-- A thumbnail, not a preview: the image's bytes ride along with
					     the message, so a small tile is all the reminder a person
					     needs before sending. -->
					<div class="relative h-14 w-14" data-testid="composer-image-thumb">
						<img
							src={`data:${src.mime};base64,${src.value}`}
							alt={src.name}
							class="size-14 rounded-lg border border-gray-200 object-cover dark:border-gray-700"
						/>
						<button
							type="button"
							aria-label="Remove {src.name}"
							class="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600 shadow-sm hover:text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:text-white"
							onclick={() => drop(index)}
						>
							<IconClose class="size-3" />
						</button>
					</div>
				{:else}
					<UploadedFile file={src} onclose={() => drop(index)} />
				{/if}
			{/await}
		{/each}
	</div>
{/if}
