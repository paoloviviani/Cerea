<!--
	The agent screen's header, on one row: the session name and a status dot on
	the left, the panels on the right. A phone has no room for four labelled
	buttons, so there they sit behind one "Panels" button that opens a bottom
	sheet; on a wider screen they stay inline with their words and fold into
	that same button only when they would not fit on the row (measured, not a
	breakpoint guess).

	The status word is spelled out only where the user must act (waiting, error);
	every other state is a dot with an accessible name and a tooltip. The engine
	label lives in the panels sheet header.
-->
<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { MediaQuery } from "svelte/reactivity";
	import { onMount } from "svelte";
	import Modal from "$lib/components/Modal.svelte";
	import TogglePill from "$lib/components/TogglePill.svelte";
	import * as s from "$lib/components/overlay/styles";
	import IconCode from "~icons/carbon/code";
	import IconTaskComplete from "~icons/carbon/task-complete";
	import IconNotes from "~icons/lucide/notebook-pen";
	import IconFolder from "~icons/carbon/folder";
	import IconTerminal from "~icons/carbon/terminal";
	import IconDiff from "~icons/lucide/diff";
	import IconPanels from "~icons/lucide/panel-right";
	import type { CodeTurnState } from "$lib/types/CodeAgent";

	export type PaneId = "tasks" | "notes" | "diff" | "files" | "terminal";
	export interface PaneItem {
		id: PaneId;
		/** The word in the sheet ("Tasks"). */
		word: string;
		/** The inline button's name, which may carry a figure ("Tasks 0/2"). */
		label: string;
		/** A live count or progress, shown beside the word in the sheet. */
		badge?: string;
		title: string;
		pressed: boolean;
		disabled?: boolean;
		/** Why it is disabled; shown under the word in the sheet. */
		reason?: string;
	}

	interface Props {
		name: string;
		path?: string;
		turnState: CodeTurnState | null;
		/** The state's word ("done"). */
		stateLabel: string;
		/** The engine's name ("opencode"), shown in the sheet header. */
		engine?: string;
		items: PaneItem[];
		onselect: (id: PaneId) => void;
		/** The sheet just opened: refresh any figure that is costly to keep live. */
		onopenpanels?: () => void;
		/** Test seam: force the phone layout on or off. */
		phone?: boolean;
	}

	let { name, path, turnState, stateLabel, engine, items, onselect, onopenpanels, phone }: Props =
		$props();

	const phoneQuery = new MediaQuery("(max-width: 639px)");
	let isPhone = $derived(phone ?? phoneQuery.current);

	const DOT: Record<CodeTurnState, string> = {
		done: "bg-green-500",
		running: "animate-pulse bg-blue-500",
		"waiting-permission": "bg-amber-500",
		error: "bg-red-500",
		idle: "bg-gray-400",
	};
	/** Needs the user's attention: the word stays next to the dot. */
	let spelledOut = $derived(turnState === "waiting-permission" || turnState === "error");

	// Fold on width: the inline group is always rendered (hidden, out of flow,
	// when folded) so its natural width stays measurable; it folds when it plus
	// a readable name no longer fit the row.
	const NAME_MIN = 160;
	let rowEl = $state<HTMLElement>();
	let groupEl = $state<HTMLElement>();
	let overflowing = $state(false);
	let folded = $derived(isPhone || overflowing);

	function measure() {
		if (!rowEl || !groupEl) return;
		const dot = rowEl.querySelector<HTMLElement>("[data-status]")?.offsetWidth ?? 0;
		overflowing = groupEl.offsetWidth + dot + NAME_MIN + 24 > rowEl.clientWidth;
	}
	onMount(() => {
		const ro = new ResizeObserver(measure);
		if (rowEl) ro.observe(rowEl);
		if (groupEl) ro.observe(groupEl);
		measure();
		return () => ro.disconnect();
	});

	let sheetOpen = $state(false);
	function pick(item: PaneItem) {
		if (item.disabled) return;
		sheetOpen = false;
		onselect(item.id);
	}
	const ICONS = {
		tasks: IconTaskComplete,
		notes: IconNotes,
		diff: IconDiff,
		files: IconFolder,
		terminal: IconTerminal,
	} as const;
	/** Anything open, so the collapsed button can show it is on. */
	let anyPressed = $derived(items.some((i) => i.pressed));
</script>

<div bind:this={rowEl} class="relative flex min-w-0 items-center gap-2" data-testid="agent-header">
	<IconCode class="size-4 shrink-0 text-ink-muted" />
	{#if name}
		<span class="min-w-0 truncate text-sm font-medium text-ink" title={path}>{name}</span>
	{/if}
	{#if turnState}
		<span class="inline-flex shrink-0 items-center" data-status>
			{#if spelledOut}
				<span
					class="{s.PILL} {turnState === 'error' ? s.PILL_TONES.bad : s.PILL_TONES.warn}"
					data-testid="status-word"
				>
					<span class="size-2 rounded-full {DOT[turnState]}" aria-hidden="true"></span>
					{stateLabel}
				</span>
			{:else}
				<span
					class="size-2.5 rounded-full {DOT[turnState]}"
					role="img"
					aria-label={stateLabel}
					title={stateLabel}
					data-testid="status-dot"
				></span>
			{/if}
		</span>
	{/if}
	<span class="min-w-0 flex-1"></span>

	<div
		bind:this={groupEl}
		class="flex items-center gap-2 whitespace-nowrap {folded
			? 'pointer-events-none invisible absolute right-0'
			: ''}"
		data-testid="pane-buttons"
		inert={folded}
	>
		{#each items as item (item.id)}
			{@const Icon = ICONS[item.id]}
			<TogglePill
				pressed={item.pressed}
				label={item.label}
				title={item.title}
				disabled={item.disabled}
				onclick={() => onselect(item.id)}
			>
				{#snippet icon()}<Icon class="size-3.5" />{/snippet}
			</TogglePill>
		{/each}
	</div>
	{#if folded}
		<button
			type="button"
			class="btn flex size-8 shrink-0 items-center justify-center rounded-lg border {anyPressed
				? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300'
				: 'border-gray-200 text-gray-500 dark:border-gray-600 dark:text-gray-400'}"
			aria-label={m["code.view.panels"]()}
			aria-haspopup="dialog"
			title={m["code.view.panels"]()}
			data-testid="panels-button"
			onclick={() => {
				sheetOpen = true;
				onopenpanels?.();
			}}
		>
			<IconPanels class="size-4" />
		</button>
	{/if}
</div>

{#if sheetOpen}
	<Modal
		sheet
		width="sm:max-w-sm"
		labelledBy="panels-sheet-title"
		onclose={() => (sheetOpen = false)}
	>
		<div class="p-4 pb-6" data-testid="panels-sheet">
			<h2 id="panels-sheet-title" class="text-base font-semibold text-ink">
				{m["code.view.panels"]()}
			</h2>
			<p class="mb-3 text-xs text-ink-muted">
				{engine ? `${engine} · ${stateLabel}` : stateLabel}
			</p>
			<ul class="flex flex-col gap-1">
				{#each items as item (item.id)}
					{@const Icon = ICONS[item.id]}
					<li>
						<button
							type="button"
							class="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-gray-50 disabled:opacity-60 dark:hover:bg-gray-700 {item.pressed
								? 'bg-blue-50 dark:bg-blue-900/30'
								: ''}"
							aria-pressed={item.pressed}
							aria-label={item.badge ? `${item.word} ${item.badge}` : item.word}
							aria-describedby={item.disabled && item.reason
								? `panel-reason-${item.id}`
								: undefined}
							disabled={item.disabled}
							title={item.title}
							onclick={() => pick(item)}
						>
							<Icon class="size-4 shrink-0 text-ink-muted" />
							<span class="flex min-w-0 flex-1 flex-col">
								<span>{item.word}</span>
								{#if item.disabled && item.reason}
									<span id="panel-reason-{item.id}" class="text-xs text-ink-muted"
										>{item.reason}</span
									>
								{/if}
							</span>
							{#if item.badge}
								<span
									class="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-ink-muted tabular-nums dark:bg-gray-700"
									data-testid="panel-badge">{item.badge}</span
								>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		</div>
	</Modal>
{/if}
