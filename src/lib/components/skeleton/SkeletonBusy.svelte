<!-- The busy wrapper: aria-busy plus the sr-only label. `SkeletonRegion` is built on it; a list that
	decides its own branches uses it directly inside `{#if delayed.visible}`. -->
<script lang="ts">
	import type { Snippet } from "svelte";
	import { m } from "$lib/paraglide/messages";
	interface Props {
		label?: string;
		/** A name for tests and scoping, rendered as `data-region`. */
		region?: string;
		class?: string;
		children: Snippet;
	}
	let { label, region, class: className = "", children }: Props = $props();
</script>

<div
	class={className}
	data-region={region}
	aria-busy="true"
	role="status"
	data-testid="skeleton-region"
>
	<span class="sr-only">{label ?? m["app.skeleton.loading"]()}</span>
	{@render children()}
</div>
