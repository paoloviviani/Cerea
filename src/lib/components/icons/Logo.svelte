<script lang="ts">
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { RIDGE_PATH, RIDGE_VIEWBOX } from "./ridgePath";

	const publicConfig = usePublicConfig();

	interface Props {
		classNames?: string;
		/**
		 * `tile` is the sidebar's square mark: the ridge bled to the edges of a
		 * day (white) or night (#0F1319) square. The default is the greeting's
		 * open 337x112 ridge on the page background. Callers size either by
		 * height (`w-auto` for the default, an explicit square for the tile).
		 */
		variant?: "default" | "tile";
		/** Stroke added on the tile's ridge (path units) to thicken it at small sizes. */
		tileStroke?: number;
	}

	let { classNames = "", variant = "default", tileStroke = 6 }: Props = $props();

	// Several marks can share a page (sidebar + greeting), and a gradient id
	// resolves document-wide, so each instance names its own.
	const uid = $props.id();
	const dayId = `ridge-day-${uid}`;
	const nightId = `ridge-night-${uid}`;

	const tile = $derived(variant === "tile");
	const w = $derived(tile ? 32 : 337);
	const h = $derived(tile ? 32 : 112);
</script>

<!--
	The mark is the mountain ridge over Turin as a filled silhouette with a
	sunset gradient: gold at the left shoulder to deep navy (day) or slate
	blue (night). One path, two gradients, switched by the class-based `.dark`
	variant every colour token uses. The tile adds the owner's bleed framing
	(translate/scale below, from the day/night SVGs) and a same-gradient
	stroke that thickens the ridge for small sizes.
-->
<svg
	width={w}
	height={h}
	viewBox={tile ? "0 0 400 400" : RIDGE_VIEWBOX}
	class="ridge-mark {classNames}"
	class:ridge-tile={tile}
	style="--g-day: url(#{dayId}); --g-night: url(#{nightId})"
	role="img"
	aria-label="{publicConfig.PUBLIC_APP_NAME} logo"
	xmlns="http://www.w3.org/2000/svg"
>
	<defs>
		<linearGradient id={dayId} gradientUnits="userSpaceOnUse" x1="54" y1="184" x2="132" y2="312">
			<stop offset="0" stop-color="#F8C868" />
			<stop offset="0.15" stop-color="#F1994C" />
			<stop offset="0.34" stop-color="#DC6A4E" />
			<stop offset="0.56" stop-color="#A45B85" />
			<stop offset="0.78" stop-color="#5A4A8B" />
			<stop offset="1" stop-color="#1A2340" />
		</linearGradient>
		<linearGradient id={nightId} gradientUnits="userSpaceOnUse" x1="54" y1="184" x2="132" y2="312">
			<stop offset="0" stop-color="#FFD27A" />
			<stop offset="0.16" stop-color="#F5A055" />
			<stop offset="0.36" stop-color="#E07356" />
			<stop offset="0.56" stop-color="#B2678F" />
			<stop offset="0.78" stop-color="#7A64A8" />
			<stop offset="1" stop-color="#4E5788" />
		</linearGradient>
	</defs>
	{#if tile}
		<rect class="tile-bg" width="400" height="400" />
		<g transform="translate(200 188) scale(1.26) translate(-226.391 -249.692)">
			<path
				class="ridge"
				d={RIDGE_PATH}
				stroke-width={tileStroke}
				stroke-linejoin="round"
				paint-order="stroke"
			/>
		</g>
	{:else}
		<path class="ridge" d={RIDGE_PATH} />
	{/if}
</svg>

<style>
	.ridge {
		fill: var(--g-day);
	}
	.ridge-tile .ridge {
		stroke: var(--g-day);
	}
	.tile-bg {
		fill: #ffffff;
	}
	:global(.dark) .ridge {
		fill: var(--g-night);
	}
	:global(.dark) .ridge-tile .ridge {
		stroke: var(--g-night);
	}
	:global(.dark) .tile-bg {
		fill: #0f1319;
	}
</style>
