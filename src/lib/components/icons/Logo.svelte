<script lang="ts">
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	interface Props {
		classNames?: string;
		/**
		 * The sidebar renders the mark at a fraction of the intro's size, and
		 * one dilation cannot serve both: a stroke that reads substantial at
		 * 52px is a hairline at 24px, while thickening the one file enough
		 * for the small size swallows the ridge's small bumps at 52px. The
		 * small variant is the same drawing with its own dilate radius and a
		 * viewBox padded to hold the grown ink.
		 */
		variant?: "default" | "small";
	}

	let { classNames = "", variant = "default" }: Props = $props();

	// Bump when any served logo file changes: the assets carry no
	// Cache-Control, so browsers heuristic-cache them for hours and a swap
	// otherwise keeps showing the old drawing to returning visitors.
	const ASSET_VERSION = "5";

	const file = $derived(variant === "small" ? "logo-small" : "logo");
	const w = $derived(variant === "small" ? 337 : 337);
	const h = $derived(variant === "small" ? 120 : 112);
</script>

<!--
	The mark is the mountain ridge over Turin — a wide outline drawing, not a
	square badge, so callers size it by height and let the width follow. Two
	files per variant, one per theme: the black ridge on a light background,
	the white one on a dark one, switched by the same class-based dark
	variant every color token uses (no `invert` filter — that would land the
	white variant at #e1e1e1, not the white it was drawn in). Both load as
	<img>, so the `thicken` filter id each file defines stays inside its own
	document. The filled-silhouette detour and earlier outlines stay
	archived under brand/ and in git history.
-->
<img
	width={w}
	height={h}
	class="{classNames} dark:hidden"
	alt="{publicConfig.PUBLIC_APP_NAME} logo"
	src="{publicConfig.assetPath}/{file}.svg?v={ASSET_VERSION}"
/>
<img
	width={w}
	height={h}
	class="{classNames} hidden dark:block"
	alt=""
	aria-hidden="true"
	src="{publicConfig.assetPath}/{file}-white.svg?v={ASSET_VERSION}"
/>
