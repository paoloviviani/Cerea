<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import CarbonStopFilledAlt from "~icons/carbon/stop-filled-alt";

	interface Props {
		classNames?: string;
		onClick?: () => void;
		showBorder?: boolean;
		/** Show the word "Stop" beside the square from `md` up; below it the button
		 * stays a square and the word stays for a screen reader. */
		showText?: boolean;
	}

	let { classNames = "", onClick, showBorder = false, showText = false }: Props = $props();
</script>

<button
	type="button"
	onclick={onClick}
	class={`stop-generating-btn btn ${showBorder ? "stop-generating-btn--spinning" : ""} ${classNames}`}
	aria-label={m["app.stop_generating"]()}
>
	<span class={showText ? "text-xs font-medium max-md:sr-only md:order-2 md:ml-1.5" : "sr-only"}
		>{showText ? m["app.stop_short"]() : m["app.stop_generating"]()}</span
	>
	<CarbonStopFilledAlt class="size-3.5 text-gray-500" />
</button>

<style>
	.stop-generating-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 9999px;
		--stop-generating-ring-color: rgba(31, 41, 55, 0.35);
	}

	.stop-generating-btn :global(svg) {
		display: block;
	}

	.stop-generating-btn::after {
		content: "";
		position: absolute;
		inset: -2px;
		border-radius: inherit;
		pointer-events: none;
		background: transparent;
	}

	/* The ring follows the button's own outline and sweeps by angle. It used to
	   rotate the whole pseudo-element, which is only a circle on a square button:
	   on the Stop pill (word beside the square) the turning box swung out over
	   the controls beside it. */
	.stop-generating-btn--spinning::after {
		padding: 2px;
		box-sizing: border-box;
		background: conic-gradient(
			from var(--stop-generating-angle),
			transparent 0deg 240deg,
			var(--stop-generating-ring-color) 240deg 360deg
		);
		mask:
			linear-gradient(#000 0 0) content-box,
			linear-gradient(#000 0 0);
		mask-composite: exclude;
		-webkit-mask-composite: xor;
		animation: stop-generating-sweep 1.2s linear infinite;
	}

	:global(.dark) .stop-generating-btn {
		--stop-generating-ring-color: rgba(255, 255, 255, 0.2);
	}

	@keyframes stop-generating-sweep {
		to {
			--stop-generating-angle: 360deg;
		}
	}
</style>
