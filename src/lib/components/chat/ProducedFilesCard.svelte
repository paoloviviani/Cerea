<script lang="ts">
	import { base } from "$app/paths";
	import FileArtifactCard from "./FileArtifactCard.svelte";
	import type { PersistedDeliverableRef } from "$lib/types/ParkedCall";

	/**
	 * Files a tool produced with no code block to list them under (a
	 * `convert_document` PDF): the same artifact cards a run's files get,
	 * where the tool ran in the message.
	 */
	interface Props {
		conversationId: string;
		files: PersistedDeliverableRef[];
	}

	let { conversationId, files }: Props = $props();
</script>

<ul class="mb-2 space-y-1" data-testid="produced-files">
	{#each files as file (file.sha256)}
		<FileArtifactCard
			file={{ path: file.name, size: file.size }}
			downloadUrl={`${base}/conversation/${conversationId}/code-execution/output/${file.sha256}`}
			sha256={file.sha256}
			autoExpand
		/>
	{/each}
</ul>
