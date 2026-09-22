<script lang="ts">
	let { animating = false, classNames = "" } = $props();
</script>

<!--
	The assistant's mark is the mountain profile in pixel art — the same
	ridgeline as the brand, redrawn one pixel at a time for the size it is
	shown at. A vector downscale of the outline logo turns to grey mush at
	14px; a 48x14 grid lands one art pixel per device pixel and stays crisp.
	While the turn streams the columns reveal left to right, hold, fade, and
	loop; once it lands the full ridge stands static. Black in light mode,
	white in dark, via currentColor. The morphing blob this replaces lives
	in git history. The artwork grid is archived under brand/ as
	pixel_ridge_avatar_{black,white}.svg.
-->
<svg
	width="48"
	height="14"
	viewBox="0 0 48 14"
	shape-rendering="crispEdges"
	class="text-black dark:text-white {classNames}"
	role="img"
	aria-label={animating ? "Generating response" : "Assistant response"}
	xmlns="http://www.w3.org/2000/svg"
>
	<g fill="currentColor" class:pixel-draw={animating}>
		<rect x="0" y="11" width="1" height="1" />
		<rect x="1" y="11" width="1" height="1" />
		<rect x="2" y="10" width="1" height="1" />
		<rect x="3" y="10" width="1" height="1" />
		<rect x="4" y="9" width="1" height="1" />
		<rect x="5" y="9" width="1" height="1" />
		<rect x="6" y="8" width="1" height="1" />
		<rect x="7" y="7" width="1" height="1" />
		<rect x="8" y="7" width="1" height="1" />
		<rect x="9" y="6" width="1" height="1" />
		<rect x="10" y="5" width="1" height="1" />
		<rect x="11" y="5" width="1" height="1" />
		<rect x="12" y="4" width="1" height="1" />
		<rect x="13" y="3" width="1" height="1" />
		<rect x="14" y="3" width="1" height="1" />
		<rect x="15" y="2" width="1" height="1" />
		<rect x="16" y="3" width="1" height="1" />
		<rect x="17" y="4" width="1" height="1" />
		<rect x="18" y="5" width="1" height="1" />
		<rect x="19" y="6" width="1" height="1" />
		<rect x="20" y="7" width="1" height="1" />
		<rect x="21" y="7" width="1" height="1" />
		<rect x="22" y="8" width="1" height="1" />
		<rect x="23" y="9" width="1" height="1" />
		<rect x="24" y="8" width="1" height="1" />
		<rect x="25" y="7" width="1" height="1" />
		<rect x="26" y="6" width="1" height="1" />
		<rect x="27" y="6" width="1" height="1" />
		<rect x="28" y="7" width="1" height="1" />
		<rect x="29" y="8" width="1" height="1" />
		<rect x="30" y="9" width="1" height="1" />
		<rect x="31" y="9" width="1" height="1" />
		<rect x="32" y="8" width="1" height="1" />
		<rect x="33" y="8" width="1" height="1" />
		<rect x="34" y="9" width="1" height="1" />
		<rect x="35" y="10" width="1" height="1" />
		<rect x="36" y="9" width="1" height="1" />
		<rect x="37" y="8" width="1" height="1" />
		<rect x="38" y="8" width="1" height="1" />
		<rect x="39" y="9" width="1" height="1" />
		<rect x="40" y="10" width="1" height="1" />
		<rect x="41" y="10" width="1" height="1" />
		<rect x="42" y="11" width="1" height="1" />
		<rect x="43" y="11" width="1" height="1" />
		<rect x="44" y="12" width="1" height="1" />
		<rect x="45" y="12" width="1" height="1" />
		<rect x="46" y="13" width="1" height="1" />
		<rect x="47" y="13" width="1" height="1" />
	</g>
</svg>

<style>
	.pixel-draw {
		animation: ridge-draw 2s steps(48) infinite;
	}
	@keyframes ridge-draw {
		0% {
			clip-path: inset(-25% 100% -25% 0);
			opacity: 1;
		}
		50% {
			clip-path: inset(-25% 0 -25% 0);
			opacity: 1;
		}
		65% {
			clip-path: inset(-25% 0 -25% 0);
			opacity: 1;
		}
		80%,
		100% {
			clip-path: inset(-25% 0 -25% 0);
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.pixel-draw {
			animation: none;
		}
	}
</style>
