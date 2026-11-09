<script lang="ts">
	import { usePublicConfig } from "$lib/utils/PublicConfig.svelte";
	import { RIDGE_PATH, RIDGE_VIEWBOX } from "./ridgePath";

	const publicConfig = usePublicConfig();

	interface Props {
		classNames?: string;
		/**
		 * `small` is the sidebar's 81x27 box; the default is the greeting's
		 * 337x112 one. Both draw the same filled ridge — only the intrinsic
		 * size differs, and callers size it by height (`w-auto`).
		 */
		variant?: "default" | "small";
	}

	let { classNames = "", variant = "default" }: Props = $props();

	// Several marks can share a page (sidebar + greeting), and a gradient id
	// resolves document-wide, so each instance names its own.
	const uid = $props.id();
	const gradientId = `ridge-${uid}`;

	const w = $derived(variant === "small" ? 81 : 337);
	const h = $derived(variant === "small" ? 27 : 112);
</script>

<!--
	The mark is the mountain ridge over Turin as a filled silhouette with a
	sunset gradient (gold at the left shoulder to deep navy in the light
	theme, to slate blue in the dark one). One path, one gradient: the two
	themes differ only in the stop colours, which are custom properties
	switched by the class-based `.dark` variant every colour token uses.
	No background square here — that is for the app icons (static/chatui/).
-->
<svg
	width={w}
	height={h}
	viewBox={RIDGE_VIEWBOX}
	class="ridge-mark {classNames}"
	role="img"
	aria-label="{publicConfig.PUBLIC_APP_NAME} logo"
	xmlns="http://www.w3.org/2000/svg"
>
	<defs>
		<linearGradient
			id={gradientId}
			gradientUnits="userSpaceOnUse"
			x1="54"
			y1="184"
			x2="132"
			y2="312"
		>
			<stop offset="0" style="stop-color: var(--ridge-0)" />
			<stop offset="0.16" style="stop-color: var(--ridge-1)" />
			<stop offset="0.35" style="stop-color: var(--ridge-2)" />
			<stop offset="0.56" style="stop-color: var(--ridge-3)" />
			<stop offset="0.78" style="stop-color: var(--ridge-4)" />
			<stop offset="1" style="stop-color: var(--ridge-5)" />
		</linearGradient>
	</defs>
	<path fill="url(#{gradientId})" d={RIDGE_PATH} />
</svg>

<style>
	.ridge-mark {
		--ridge-0: #f8c868;
		--ridge-1: #f1994c;
		--ridge-2: #dc6a4e;
		--ridge-3: #a45b85;
		--ridge-4: #5a4a8b;
		--ridge-5: #1a2340;
	}
	:global(.dark) .ridge-mark {
		--ridge-0: #ffd27a;
		--ridge-1: #f5a055;
		--ridge-2: #e07356;
		--ridge-3: #b2678f;
		--ridge-4: #7a64a8;
		--ridge-5: #4e5788;
	}
</style>
