<!-- Cards (projects, knowledge bases, connectors): icon, title, subtitle; fixed 4.5rem height. -->
<script lang="ts">
	import Skeleton from "./Skeleton.svelte";
	interface Props {
		count?: number;
	}
	let { count = 3 }: Props = $props();
</script>

<div class="flex flex-col gap-2">
	{#each Array.from({ length: count }, (_, i) => i) as i (i)}
		<div class="flex h-[4.5rem] items-center gap-3 rounded-lg border border-line-quiet px-3">
			<Skeleton variant="block" width="2.25rem" height="2.25rem" />
			<div class="flex flex-1 flex-col gap-2">
				<Skeleton width="40%" height="0.85rem" />
				<Skeleton width="65%" height="0.7rem" />
			</div>
		</div>
	{/each}
</div>
