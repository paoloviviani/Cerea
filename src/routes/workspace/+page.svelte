<!--
	A thin wrapper: the frame, tabs and managers live in
	`components/workspace/WorkspacePanel.svelte`, which is what the tests mount.
-->
<script lang="ts">
	import WorkspacePanel from "$lib/components/workspace/WorkspacePanel.svelte";
	import type { PageData } from "./$types";

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();
</script>

<WorkspacePanel {data} />
