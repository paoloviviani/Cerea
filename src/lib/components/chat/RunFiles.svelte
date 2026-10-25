<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import FileArtifactCard from "./FileArtifactCard.svelte";
	import type { RunState } from "$lib/utils/execution/runs.svelte";

	/**
	 * A run's produced files as rows under a divider inside the surface that
	 * already frames the run: never cards inside the card. Live files carry
	 * the sha256 the browser computed; replayed ones the stored reference's.
	 * Both go through the one artifact card.
	 */
	interface Props {
		state?: RunState;
		inPanel?: boolean;
	}

	let { state: runState, inPanel = false }: Props = $props();

	let live = $derived(runState?.outputFiles ?? []);
	let persisted = $derived(runState?.persistedFiles ?? []);
</script>

{#if live.length > 0}
	<ul
		class="border-t border-gray-300/50 px-4 py-2 dark:border-gray-600/40"
		aria-label={m["chat.run_files.label"]()}
		data-testid="run-files"
	>
		{#each live as file (file.path)}
			<FileArtifactCard {file} sha256={file.sha256} {inPanel} autoExpand variant="row" />
		{/each}
	</ul>
{:else if persisted.length > 0}
	<ul
		class="border-t border-gray-300/50 px-4 py-2 dark:border-gray-600/40"
		aria-label={m["chat.run_files.label"]()}
		data-testid="run-files"
	>
		{#each persisted as file (file.downloadUrl + file.name)}
			<FileArtifactCard
				file={{ path: file.name, size: file.size }}
				downloadUrl={file.downloadUrl}
				sha256={file.sha256}
				uploaded={file.uploaded}
				{inPanel}
				autoExpand
				variant="row"
			/>
		{/each}
	</ul>
{/if}
