<!--
	A drop area for a batch of files, plus a click-to-browse fallback.

	Two things it deliberately does *not* do.

	**It does not upload.** It collects a list and hands it back, because the
	caller decides where the files go — a new knowledge base that does not exist
	yet, or an existing one. A component that uploaded as soon as a file landed
	would be unusable in the create dialog, where there is nothing to upload to
	until the base is made.

	**It does not filter by extension.** The gateway's extractor holds the
	allowlist and it is the only thing that knows the answer — it sniffs the
	bytes rather than trusting the name, and it accepts formats this component
	should not have to keep a list of. Refusing a file here on its extension
	would mean two allowlists, and the wrong one would be the one people meet.
	What it does enforce is the *size* limit, because that one is known up front
	and a rejection after a long upload is the worse place to learn it.
-->
<script lang="ts">
	import CarbonDocumentAdd from "~icons/carbon/document-add";
	import CarbonClose from "~icons/carbon/close";

	interface Props {
		files: File[];
		maxBytes?: number;
		disabled?: boolean;
		hint?: string;
	}

	let { files = $bindable([]), maxBytes, disabled = false, hint }: Props = $props();

	let hovering = $state(false);
	let refused = $state<string[]>([]);
	let input: HTMLInputElement | null = null;

	function humanise(bytes: number): string {
		if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
		if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
		return `${bytes} B`;
	}

	function accept(incoming: FileList | null) {
		if (!incoming || disabled) return;
		const tooBig: string[] = [];
		const kept: File[] = [];
		for (const file of Array.from(incoming)) {
			if (maxBytes && file.size > maxBytes) {
				tooBig.push(`${file.name} (${humanise(file.size)})`);
				continue;
			}
			// Deduplicated by name *and* size: dropping the same batch twice is
			// an easy accident, and two identical uploads are two documents to
			// pay to index.
			if (files.some((existing) => existing.name === file.name && existing.size === file.size)) {
				continue;
			}
			kept.push(file);
		}
		files = [...files, ...kept];
		refused = tooBig;
	}

	function drop(event: DragEvent) {
		event.preventDefault();
		hovering = false;
		accept(event.dataTransfer?.files ?? null);
	}

	function remove(index: number) {
		files = files.filter((_, i) => i !== index);
	}
</script>

<div class="flex flex-col gap-2">
	<!-- A button rather than a div with a click handler: this is the
	     keyboard-reachable way to open the picker, and a drop area that only
	     works with a mouse is a drop area half the people cannot use. -->
	<button
		type="button"
		{disabled}
		onclick={() => input?.click()}
		ondragover={(event) => {
			event.preventDefault();
			hovering = true;
		}}
		ondragleave={() => (hovering = false)}
		ondrop={drop}
		class="flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed p-6 text-sm transition-colors disabled:opacity-50 {hovering
			? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
			: 'border-gray-300 hover:bg-gray-50 dark:border-gray-600 dark:hover:bg-gray-900'}"
	>
		<CarbonDocumentAdd class="text-gray-400" />
		<span>Drop files here, or click to choose</span>
		<span class="text-xs text-gray-500 dark:text-gray-400">
			{hint ?? "Word, Excel, PowerPoint, or a PDF with a text layer"}
			{#if maxBytes}· up to {humanise(maxBytes)} each{/if}
		</span>
	</button>

	<input
		bind:this={input}
		type="file"
		multiple
		class="hidden"
		onchange={(event) => {
			accept((event.currentTarget as HTMLInputElement).files);
			// Cleared so choosing the same file again still fires a change.
			(event.currentTarget as HTMLInputElement).value = "";
		}}
	/>

	{#if refused.length > 0}
		<p class="text-xs text-red-700 dark:text-red-300">
			Too large, not added: {refused.join(", ")}
		</p>
	{/if}

	{#if files.length > 0}
		<ul class="flex flex-col gap-1">
			{#each files as file, index (file.name + file.size)}
				<li
					class="flex items-center justify-between gap-2 rounded border border-gray-200 px-2 py-1 text-xs dark:border-gray-700"
				>
					<span class="truncate">{file.name}</span>
					<span class="flex shrink-0 items-center gap-2">
						<span class="text-gray-500">{humanise(file.size)}</span>
						<button
							type="button"
							onclick={() => remove(index)}
							aria-label="Remove {file.name}"
							class="text-gray-500 hover:text-gray-900 dark:hover:text-gray-100"
						>
							<CarbonClose />
						</button>
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
