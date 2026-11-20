<!--
	One placeholder shape: a text `line`, a `block`, or a `circle`. Colours come from the text
	token mixed into transparency, so it follows light/dark and the Warm/Neutral/Cool tones with no
	palette of its own. The shimmer is a slow highlight sweep; `prefers-reduced-motion` freezes it.
	Decorative: the region around it carries `aria-busy` and the "Loading…" label.
-->
<script lang="ts">
	interface Props {
		variant?: "line" | "block" | "circle";
		/** Any CSS length; a line defaults to the full width of its row. */
		width?: string;
		/** Any CSS length; a line defaults to 1em of text height. */
		height?: string;
		class?: string;
	}
	let { variant = "line", width, height, class: className = "" }: Props = $props();
	const style = $derived(
		[
			width ? `width:${width}` : "",
			height ? `height:${height}` : "",
			variant === "circle" && width && !height ? `height:${width}` : "",
		]
			.filter(Boolean)
			.join(";")
	);
</script>

<span
	class="skeleton skeleton-{variant} {className}"
	{style}
	aria-hidden="true"
	data-testid="skeleton"
></span>

<style>
	.skeleton {
		display: block;
		flex: none;
		max-width: 100%;
		background-color: color-mix(in srgb, var(--colour-text, #888) 8%, transparent);
		background-image: linear-gradient(
			90deg,
			transparent 0%,
			color-mix(in srgb, var(--colour-text, #888) 9%, transparent) 50%,
			transparent 100%
		);
		background-size: 200% 100%;
		background-repeat: no-repeat;
		background-position: 200% 0;
		animation: skeleton-shimmer 1.6s ease-in-out infinite;
	}
	.skeleton-line {
		width: 100%;
		height: 0.9em;
		border-radius: 0.375rem;
	}
	.skeleton-block {
		width: 100%;
		height: 3rem;
		border-radius: 0.5rem;
	}
	.skeleton-circle {
		border-radius: 9999px;
	}
	@keyframes skeleton-shimmer {
		from {
			background-position: 200% 0;
		}
		to {
			background-position: -100% 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.skeleton {
			animation: none;
			background-image: none;
		}
	}
</style>
