<!-- A settings row: label and hint on the left, a control on the right. Fixed 3.5rem height. -->
<script lang="ts">
	import Skeleton from "./Skeleton.svelte";
	interface Props {
		count?: number;
	}
	let { count = 3 }: Props = $props();
</script>

<div class="flex flex-col divide-y divide-line-quiet">
	{#each Array.from({ length: count }, (_, i) => i) as i (i)}
		<div class="flex h-14 items-center justify-between gap-4">
			<div class="flex flex-1 flex-col gap-1.5">
				<Skeleton width="30%" height="0.85rem" />
				<Skeleton width="55%" height="0.7rem" />
			</div>
			<Skeleton variant="block" width="5rem" height="1.75rem" />
		</div>
	{/each}
</div>
