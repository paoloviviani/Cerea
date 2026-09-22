<script lang="ts">
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	interface Props {
		classNames?: string;
		/**
		 * `small` renders the pixel-art ridge — the mark designed for small
		 * boxes — instead of the vector outline. The vector's charcoal ink
		 * downscales to a grey smear below ~48px and no dilate radius fixes
		 * both readings at once; the 24x8 pixel grid (the verbatim
		 * makebead-24x8.png in brand/) is crisp with full pixel coverage at
		 * every integer scale. The sidebar pairs it with an 18px font whose
		 * stems are ~2px, so the mark renders at h-4 (16px, a clean 2x).
		 */
		variant?: "default" | "small";
	}

	let { classNames = "", variant = "default" }: Props = $props();

	// Bump when any served logo file changes: the assets carry no
	// Cache-Control, so browsers heuristic-cache them for hours and a swap
	// otherwise keeps showing the old drawing to returning visitors.
	const ASSET_VERSION = "7";

	const file = $derived(variant === "small" ? "logo-small" : "logo");
	const w = $derived(variant === "small" ? 48 : 337);
	const h = $derived(variant === "small" ? 16 : 112);
</script>

<!--
	The mark is the mountain ridge over Turin — a wide outline drawing, not a
	square badge, so callers size it by height and let the width follow. Two
	files per variant, one per theme: the black ridge on a light background,
	the white one on a dark one, switched by the same class-based dark
	variant every color token uses (no `invert` filter — that would land the
	white variant at #e1e1e1, not the white it was drawn in). Both load as
	<img>, so the `thicken` filter id each file defines stays inside its own
	document. The pixel-art small variant is theme-switched the same way.
	The filled-silhouette detour and earlier outlines stay archived under
	brand/ and in git history.
-->
{#if variant === "small"}
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
{:else}
	<img
		width={w}
		height={h}
		class="{classNames} dark:hidden"
		alt="{publicConfig.PUBLIC_APP_NAME} logo"
		src="{publicConfig.assetPath}/logo.svg?v={ASSET_VERSION}"
	/>
	<img
		width={w}
		height={h}
		class="{classNames} hidden dark:block"
		alt=""
		aria-hidden="true"
		src="{publicConfig.assetPath}/logo-white.svg?v={ASSET_VERSION}"
	/>
{/if}
