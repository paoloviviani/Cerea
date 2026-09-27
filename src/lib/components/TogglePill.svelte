<!--
	An on/off pill in the composer's toggle idiom: blue when on, gray when
	off, `aria-pressed` carrying the state. Shared by chat's own toggles (web
	search, tool approval) and /code's provider-feature toggles (auto-accept)
	— one class list rather than two copies drifting apart.

	Presentational only: what a click *means* — an optimistic flip, a
	background request, a rollback toast on refusal — stays with the caller.
-->
<script lang="ts">
	import type { Snippet } from "svelte";

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
		onclick: () => void;
		/** The pill's own icon, since it differs per toggle (and, for /code's
		 * feature pills, per state — on/off/vetoed). */
		icon: Snippet;
	}

	let { pressed, label, title, disabled = false, compact = false, onclick, icon }: Props = $props();
</script>

<button
	type="button"
	class="flex h-7 flex-none items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors {compact
		? 'max-sm:size-8 max-sm:justify-center max-sm:gap-0 max-sm:rounded-full max-sm:border-0 max-sm:bg-transparent max-sm:px-0 max-sm:text-base'
		: ''} {pressed
		? 'border-blue-600 bg-blue-100 text-blue-800 shadow-xs dark:border-blue-400 dark:bg-blue-900/60 dark:text-blue-100'
		: 'border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700'} disabled:opacity-60"
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
</button>
