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
		/** /code's composer row goes icon-only under `sm`, keeping the label
		 * for a screen reader (`sr-only`) rather than dropping it — chat's own
		 * two toggles never compact, so this defaults off. */
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
		? 'max-sm:h-6 max-sm:gap-0.5 max-sm:px-1.5'
		: ''} {pressed
		? 'border-blue-600/30 bg-blue-50 text-blue-700 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-300'
		: 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'} disabled:opacity-60"
	aria-pressed={pressed}
	{title}
	{disabled}
	{onclick}
>
	{@render icon()}
	<span class={compact ? "max-sm:sr-only" : ""}>{label}</span>
</button>
