<!--
	A region that renders either its placeholder or its complete content, never half.

	`loading` is the region's first load only (everything it needs, combined by the caller);
	a refresh of content already on screen keeps the content in place and is not "loading".
	Timing is the shared anti-flicker rule (`delayedLoading`): nothing for a load under ~150 ms,
	and a placeholder that appeared stays at least ~300 ms.

	While the placeholder shows, the wrapper is `aria-busy="true"` with an sr-only label. When the
	content is shown the wrapper adds no element at all, so existing layout is untouched.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import SkeletonBusy from "./SkeletonBusy.svelte";
	import { delayedLoading } from "$lib/utils/delayedLoading.svelte";

	interface Props {
		loading: boolean;
		/** The placeholder; reserve the final content's size. */
		skeleton: Snippet;
		children?: Snippet;
		/** The sr-only label; defaults to the generic "Loading…". */
		label?: string;
		class?: string;
	}
	let { loading, skeleton, children, label, class: className = "" }: Props = $props();
	const d = delayedLoading(() => loading);
</script>

{#if d.visible}
	<SkeletonBusy class={className} {label}>{@render skeleton()}</SkeletonBusy>
{:else if !loading}
	{@render children?.()}
{/if}
