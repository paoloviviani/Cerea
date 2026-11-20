<!-- List rows (sidebar chats/projects, workspace sessions): fixed row height so the swap does not shift. -->
<script lang="ts">
	import Skeleton from "./Skeleton.svelte";
	interface Props {
		count?: number;
		/** A leading circle/icon slot. */
		leading?: boolean;
		/** Row height, any CSS length. */
		rowHeight?: string;
		/** Left indent, any CSS length. */
		indent?: string;
	}
	let { count = 4, leading = false, rowHeight = "2rem", indent = "0" }: Props = $props();
	// Varied widths read as text, not as a bar chart.
	const widths = ["72%", "58%", "84%", "46%", "66%", "78%"];
</script>

<div class="flex flex-col" style="padding-left:{indent}">
	{#each Array.from({ length: count }, (_, i) => i) as i (i)}
		<div class="flex items-center gap-2 px-2" style="height:{rowHeight}">
			{#if leading}<Skeleton variant="circle" width="1rem" />{/if}
			<Skeleton width={widths[i % widths.length]} height="0.8rem" />
		</div>
	{/each}
</div>
