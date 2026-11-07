<script lang="ts">
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";

	const publicConfig = usePublicConfig();

	interface Props {
		classNames?: string;
		/**
		 * `small` renders the thick ridge (brand/logo_thick_*.svg) — the same
		 * hand-drawn line as the default, drawn with a heavy stroke so it holds
		 * up in a small box: at the sidebar's 27px height (81px wide) the line is
		 * still a clear, continuous ridge in both themes, where the thin outline
		 * goes to a grey smear. The sidebar shows it alone, without the app name
		 * beside it. It replaced the pixel-art mark (logo-small*.svg, kept for
		 * the favicon's lineage) in 2026-11.
		 */
		variant?: "default" | "small";
	}

	let { classNames = "", variant = "default" }: Props = $props();

	// Bump when any served logo file changes: the assets carry no
	// Cache-Control, so browsers heuristic-cache them for hours and a swap
	// otherwise keeps showing the old drawing to returning visitors.
	const ASSET_VERSION = "9";

	const file = $derived(variant === "small" ? "logo-thick" : "logo");
	const w = $derived(variant === "small" ? 81 : 337);
	const h = $derived(variant === "small" ? 27 : 112);
</script>

<!--
	The mark is the mountain ridge over Turin — a wide outline drawing, not a
	square badge, so callers size it by height and let the width follow. Two
	files per variant, one per theme: the black ridge on a light background,
	the white one on a dark one, switched by the same class-based dark
	variant every color token uses (no `invert` filter — that would land the
	white variant at #e1e1e1, not the white it was drawn in). Both load as
	<img>, so the `thicken` filter id each file defines stays inside its own
	document. The thick small variant is theme-switched the same way.
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
