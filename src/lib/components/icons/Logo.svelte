<script lang="ts">
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	interface Props {
		classNames?: string;
		/**
		 * The sidebar renders the mark at ~24px, where the default file's
		 * charcoal ink downscales into a grey smear: at that size every pixel
		 * of the band is half-toned, none reaches full coverage, and the mark
		 * reads grey next to the wordmark. The small variant is the same
		 * drawing at the same weight (radius 3 — heavier dilation only closes
		 * the valleys and makes the smear worse, as radius 4.5 proved live),
		 * drawn in pure black so its core pixels still reach full coverage at
		 * sidebar size. Same viewBox, same aspect; only the ink differs.
		 */
		variant?: "default" | "small";
	}

	let { classNames = "", variant = "default" }: Props = $props();

	// Bump when any served logo file changes: the assets carry no
	// Cache-Control, so browsers heuristic-cache them for hours and a swap
	// otherwise keeps showing the old drawing to returning visitors.
	const ASSET_VERSION = "6";

	const file = $derived(variant === "small" ? "logo-small" : "logo");
	const w = 337;
	const h = 112;
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
