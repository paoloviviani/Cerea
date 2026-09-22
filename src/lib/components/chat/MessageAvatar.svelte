<script lang="ts">
	let { animating = false, classNames = "" } = $props();
</script>

<!--
	The assistant's mark is the mountain profile in pixel art — the same
	ridgeline as the brand, redrawn one pixel at a time for the size it is
	shown at. A vector downscale of the outline logo turns to grey mush at
	14px; a 24x8 grid traced pixel-for-pixel from the supplied art stays crisp.
	While the turn streams the columns reveal left to right, hold, fade, and
	loop; once it lands the full ridge stands static. Black in light mode,
	white in dark, via currentColor. The morphing blob this replaces lives
	in git history. The artwork grid is archived under brand/ as
	pixel_ridge_avatar.png (the verbatim upload).
-->
<svg
	width="24"
	height="8"
	viewBox="0 0 24 8"
	shape-rendering="crispEdges"
	class="text-black dark:text-white {classNames}"
	role="img"
	aria-label={animating ? "Generating response" : "Assistant response"}
	xmlns="http://www.w3.org/2000/svg"
>
	<g fill="currentColor" class:pixel-draw={animating}>
		<rect x="11" y="0" width="1" height="1" />
		<rect x="10" y="1" width="1" height="1" />
		<rect x="12" y="1" width="1" height="1" />
		<rect x="9" y="2" width="1" height="1" />
		<rect x="13" y="2" width="1" height="1" />
		<rect x="7" y="3" width="1" height="1" />
		<rect x="8" y="3" width="1" height="1" />
		<rect x="14" y="3" width="1" height="1" />
		<rect x="5" y="4" width="1" height="1" />
		<rect x="6" y="4" width="1" height="1" />
		<rect x="15" y="4" width="1" height="1" />
		<rect x="20" y="4" width="1" height="1" />
		<rect x="4" y="5" width="1" height="1" />
		<rect x="16" y="5" width="1" height="1" />
		<rect x="19" y="5" width="1" height="1" />
		<rect x="21" y="5" width="1" height="1" />
		<rect x="0" y="6" width="1" height="1" />
		<rect x="1" y="6" width="1" height="1" />
		<rect x="2" y="6" width="1" height="1" />
		<rect x="3" y="6" width="1" height="1" />
		<rect x="17" y="6" width="1" height="1" />
		<rect x="18" y="6" width="1" height="1" />
		<rect x="22" y="6" width="1" height="1" />
		<rect x="23" y="7" width="1" height="1" />
	</g>
</svg>

<style>
	.pixel-draw {
		animation: ridge-draw 2s steps(24) infinite;
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
