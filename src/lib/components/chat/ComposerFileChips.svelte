<script lang="ts">
	/**
	 * The composer's pending attachments as removable chips, above the input —
	 * chat's strip, for any composer that keeps a bindable `File[]` (see
	 * `$lib/utils/composerFiles`). Previews are the files' own bytes (base64),
	 * so nothing is fetched before the message is sent.
	 */
	import { fly } from "svelte/transition";
	import { cubicInOut } from "svelte/easing";
	import type { MessageFile } from "$lib/types/Message";
	import file2base64 from "$lib/utils/file2base64";
	import UploadedFile from "./UploadedFile.svelte";

	interface Props {
		files: File[];
		/** Hide the strip (chat hides it while a reply is generating). */
		hidden?: boolean;
	}

	let { files = $bindable([]), hidden = false }: Props = $props();

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
</script>

{#if sources?.length && !hidden}
	<div
		in:fly|local={sources.length === 1 ? { y: -20, easing: cubicInOut } : undefined}
		class="flex flex-row flex-wrap justify-center gap-2.5 rounded-xl pb-3"
	>
		{#each sources as source, index}
			{#await source then src}
				<UploadedFile
					file={src}
					onclose={() => {
						files = files.filter((_, i) => i !== index);
					}}
				/>
			{/await}
		{/each}
	</div>
{/if}
