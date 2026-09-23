<!-- A thin wrapper: the frame lives in `components/code/CodePanel.svelte`. -->
<script lang="ts">
	import CodePanel from "$lib/components/code/CodePanel.svelte";
	import type { PageData } from "./$types";

	interface Props {
		data: PageData;
	}

	let { data }: Props = $props();
</script>

<CodePanel enabled={data.codeAgentsEnabled} />
