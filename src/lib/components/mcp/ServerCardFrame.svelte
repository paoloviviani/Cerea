<!--
	The frame every MCP server card shares (configured, connectors, "On your machines").

	One look for every card: the card itself is never tinted, so a built-in connector
	and one you added read the same. Colour belongs to the status pills only.

	One layout for the three, so a name is never lost to the switch beside it. Below
	`sm` the card stacks: the name (full width, wrapping to two lines, never
	truncated), the machine as a small second line for a local server, the
	description clamped to two lines, the status pills, then a footer row with the
	"Default in new chats" switch. From `sm` up the switch sits to the right of
	the name, as it always did, under its longer label.

	When `onopen` is given the name is a button (the keyboard path to the detail
	sheet) and a click anywhere else on the card opens it too, except on a button,
	a link, a field or the switch, which keep doing their own job.
-->
<script lang="ts">
	import type { Snippet } from "svelte";

	interface Props {
		name: string;
		/** A small favicon in front of the name. */
		iconSrc?: string;
		/** A local server's machine, shown as "on <machine>". */
		machine?: string;
		description?: string;
		/** The status pills row. */
		pills?: Snippet;
		/** The switch with its own `name`; the label text is this frame's. */
		toggle: Snippet;
		/** Label beside the switch from `sm` up, then the shorter one below it. */
		toggleLabel: string;
		toggleLabelShort: string;
		toggleTitle?: string;
		/** Error messages, buttons and forms under the grid. */
		children?: Snippet;
		onopen?: () => void;
		testid?: string;
	}

	let {
		name,
		iconSrc,
		machine,
		description,
		pills,
		toggle,
		toggleLabel,
		toggleLabelShort,
		toggleTitle,
		children,
		onopen,
		testid,
	}: Props = $props();

	function onCardClick(event: MouseEvent) {
		if (!onopen) return;
		const target = event.target as Element | null;
		if (target?.closest("button, a, input, select, textarea, label, [data-no-open]")) return;
		// Selecting text to copy it is not a request to open anything.
		if (window.getSelection()?.toString()) return;
		onopen();
	}
</script>

<!-- The card's own click is a pointer convenience; the name button is the keyboard path. -->
<div
	role="presentation"
	class="rounded-lg border bg-linear-to-br transition-colors {onopen
		? 'cursor-pointer'
		: ''} border-gray-200 bg-white from-black/5 dark:border-gray-700 dark:bg-gray-800 dark:from-white/5"
	data-testid={testid}
	onclick={onCardClick}
>
	<div class="px-4 py-3.5">
		<div class="mb-2 grid grid-cols-1 gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-3">
			<div class="min-w-0 sm:col-start-1 sm:row-start-1">
				<h4
					data-testid="card-name"
					class="line-clamp-2 font-semibold break-words text-gray-900 dark:text-gray-100"
				>
					{#if iconSrc}
						<img src={iconSrc} alt="" class="mr-2 inline size-4 rounded-sm align-[-2px]" />
					{/if}
					{#if onopen}
						<button
							type="button"
							aria-haspopup="dialog"
							onclick={onopen}
							class="text-left font-semibold break-words hover:underline focus-visible:underline focus-visible:outline-hidden"
						>
							{name}
						</button>
					{:else}
						{name}
					{/if}
				</h4>
				{#if machine}
					<p class="text-xs text-gray-500 dark:text-gray-400">on {machine}</p>
				{/if}
				{#if description}
					<p
						data-testid="card-description"
						title={description}
						class="truncate text-sm text-gray-600 dark:text-gray-400"
					>
						{description}
					</p>
				{/if}
			</div>

			{#if pills}
				<div class="flex flex-wrap items-center gap-2 sm:col-span-2 sm:row-start-2">
					{@render pills()}
				</div>
			{/if}

			<!-- Source order is the phone's: the footer comes last. From sm up it moves
			     to the top right, beside the name. -->
			<div
				data-no-open
				data-testid="card-footer"
				title={toggleTitle}
				class="flex items-center justify-between gap-2 border-t border-gray-200/70 pt-2 sm:col-start-2 sm:row-start-1 sm:justify-end sm:border-0 sm:pt-0.5 dark:border-gray-700/70"
			>
				<span class="text-xs text-gray-600 dark:text-gray-400">
					<span class="sm:hidden">{toggleLabelShort}</span>
					<span class="max-sm:hidden">{toggleLabel}</span>
				</span>
				{@render toggle()}
			</div>
		</div>

		{@render children?.()}
	</div>
</div>
