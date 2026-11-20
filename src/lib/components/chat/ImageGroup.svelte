<!--
	The row of one message's attachments. It only provides the group the picture tiles inside it
	report to (`imageGroup.svelte.ts`): they appear together, not one after another.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import { provideImageGroup } from "$lib/utils/imageGroup.svelte";

	interface Props {
		class?: string;
		children: Snippet;
	}
	let { class: className = "", children }: Props = $props();
	provideImageGroup();
</script>

<div class={className}>
	{@render children()}
</div>
