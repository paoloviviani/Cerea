<!--
	Passthrough: the page frame (title, tab bar, scroll container) lives in
	`routes/settings/+layout.svelte`, mirroring the admin area. This file
	remains only because the `(nav)` route group exists; it renders its child
	page unchanged.
-->
<script lang="ts">
	interface Props {
		children?: import("svelte").Snippet;
	}

	let { children }: Props = $props();
</script>

{@render children?.()}
