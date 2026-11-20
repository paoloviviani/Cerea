<!-- A message bubble: avatar plus three text lines. -->
<script lang="ts">
	import Skeleton from "./Skeleton.svelte";
	interface Props {
		/** Right-aligned shorter bubble, as a user's message. */
		user?: boolean;
	}
	let { user = false }: Props = $props();
</script>

<div class="flex gap-3 py-3 {user ? 'justify-end' : ''}">
	{#if user}
		<div class="flex w-2/3 flex-col items-end gap-2">
			<Skeleton width="80%" />
			<Skeleton width="45%" />
		</div>
	{:else}
		<Skeleton variant="circle" width="1.75rem" />
		<div class="flex min-w-0 flex-1 flex-col gap-2">
			<Skeleton width="92%" />
			<Skeleton width="85%" />
			<Skeleton width="60%" />
		</div>
	{/if}
</div>
