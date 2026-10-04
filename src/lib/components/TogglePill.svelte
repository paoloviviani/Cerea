<!--
	An on/off pill in the composer's toggle idiom: blue when on, gray when
	off, `aria-pressed` carrying the state. Shared by chat's own toggles (web
	search, tool approval) and /code's panel toggles
	— one class list (`composerPill.ts`, which /code's agent pickers also
	build from) rather than copies drifting apart.

	Presentational only: what a click *means* — an optimistic flip, a
	background request, a rollback toast on refusal — stays with the caller.
-->
<script lang="ts">
	import type { Snippet } from "svelte";
	import { composerPillClass } from "$lib/components/composerPill";

	interface Props {
		pressed: boolean;
		label: string;
		title?: string;
		disabled?: boolean;
		/** Icon-only under `sm`, keeping the label for a screen reader
		 * (`sr-only`) rather than dropping it. Icon size matches the
		 * composer's plus button (`size-8` target, `text-base` icon), so the
		 * compacted pills don't read as smaller siblings. */
		compact?: boolean;
		/** A short figure ("3/7") kept visible when `compact` hides the label,
		 * so progress does not vanish on a phone. Part of the accessible name
		 * only through `label`, which the caller already carries it in. */
		badge?: string;
		onclick: () => void;
		/** The pill's own icon, since it differs per toggle (and, for some,
		 * per state). */
		icon: Snippet;
	}

	let {
		pressed,
		label,
		title,
		disabled = false,
		compact = false,
		badge,
		onclick,
		icon,
	}: Props = $props();
</script>

<button
	type="button"
	class={composerPillClass({ pressed, compact })}
	aria-pressed={pressed}
	{title}
	{disabled}
	{onclick}
>
	<!-- The icon itself carries the state, not just the pill's chrome: on
	     icons in full-saturation blue, off icons in muted gray — the pair a
	     compacted icon-only pill shows is readable at a glance, where a
	     tinted border and a pale wash were not. -->
	{@render icon()}
	<span class={compact ? "max-sm:sr-only" : ""}>{label}</span>
	{#if compact && badge}
		<span
			class="hidden text-[10px] leading-none font-semibold tabular-nums max-sm:inline"
			aria-hidden="true"
			data-testid="pill-badge">{badge}</span
		>
	{/if}
</button>
