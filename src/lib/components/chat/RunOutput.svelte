<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { formatNumber } from "$lib/i18n/format";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import CarbonWarningAlt from "~icons/carbon/warning-alt";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import RunFiles from "./RunFiles.svelte";
	import type { RunState } from "$lib/utils/execution/runs.svelte";
	import type { Snippet } from "svelte";

	/**
	 * Shared presentation of one code execution outcome: a status strip and the
	 * captured output blocks. Used under chat code blocks and in the artifact
	 * panel's code view, so both surfaces report the runtime identically.
	 */
	interface Props {
		state?: RunState;
		/** Wrapper classes; the chat block adds margins, the panel none. */
		class?: string;
		/**
		 * Whether to render the run's output files here. Default true, so chat
		 * blocks and the artifact panel show files inline as before. The
		 * `execute_code` card sets this false and renders the files in its own
		 * always-visible box, so collapsing the (settled) output never hides a
		 * deliverable the person asked for.
		 */
		showFiles?: boolean;
		/**
		 * Rendered inside the artifact panel: file cards must not offer to
		 * open the panel (it is already showing this cell).
		 */
		inPanel?: boolean;
		/**
		 * No surface and no status row of its own: only the captured output
		 * blocks, for a parent that draws the one surface (the `execute_code`
		 * card).
		 */
		bare?: boolean;
		/** Content between the status row and the output, inside the same surface (a fence's "View code"). */
		before?: Snippet;
	}

	let {
		state: runState,
		class: className = "",
		showFiles = true,
		inPanel = false,
		bare = false,
		before,
	}: Props = $props();
	// Bound off `state`: a `state` binding in scope turns every `$state` rune
	// into a store reference (store_rune_conflict), so the runes below would
	// stop compiling. Call sites still pass `state={...}`.

	let spinner = $derived(
		!!runState &&
			(runState.status === "loading" ||
				runState.status === "running" ||
				runState.status === "queued")
	);

	let duration = $derived.by(() => {
		if (!runState?.finishedAt || !runState.startedAt) return "";
		const ms = runState.finishedAt - runState.startedAt;
		return ms < 100
			? ""
			: ms < 10_000
				? m["chat.run.seconds"]({
						value: formatNumber(ms / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
					})
				: m["chat.run.seconds"]({ value: formatNumber(Math.round(ms / 1000)) });
	});

	type OutputBlock = { label: string; tone: "plain" | "error"; text: string };

	let outputBlocks = $derived.by((): OutputBlock[] => {
		const blocks: OutputBlock[] = [];
		const outcome = runState?.outcome;
		if (!outcome) return blocks;
		if (outcome.stdout)
			blocks.push({ label: m["chat.run.output"](), tone: "plain", text: outcome.stdout });
		if (outcome.stderr)
			blocks.push({
				label: m["chat.run.stderr"](),
				tone: outcome.ok ? "plain" : "error",
				text: outcome.stderr,
			});
		if (!outcome.ok && outcome.error)
			blocks.push({ label: m["chat.run.error"](), tone: "error", text: outcome.error });
		else if (outcome.ok && outcome.result)
			blocks.push({ label: m["chat.run.result"](), tone: "plain", text: outcome.result });
		return blocks;
	});
</script>

{#snippet blocksView()}
	{#if runState?.sandboxError}
		<pre
			class="scrollbar-custom max-h-60 overflow-y-auto rounded-lg bg-amber-50 p-2 font-mono text-xs break-all whitespace-pre-wrap text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">{runState.sandboxError}</pre>
	{/if}
	{#each outputBlocks as block (block.label)}
		<div class="space-y-1">
			<div
				class="text-[10px] font-semibold uppercase {block.tone === 'error'
					? 'text-amber-600 dark:text-amber-400'
					: 'text-gray-400 dark:text-gray-500'}"
			>
				{block.label}
			</div>
			<pre
				class="scrollbar-custom max-h-60 overflow-y-auto rounded-lg {block.tone === 'error'
					? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'
					: 'bg-gray-500/10'} p-2 font-mono text-xs break-all whitespace-pre-wrap">{block.text}</pre>
		</div>
	{/each}
{/snippet}

{#if runState && bare}
	<div class="space-y-2 {className}">{@render blocksView()}</div>
{:else if runState}
	<div
		class="min-w-[min(26rem,calc(100vw-4.5rem))] rounded-[14px] border border-gray-300/60 bg-gray-500/[0.06] dark:border-gray-600/50 {className}"
		data-testid="run-output"
	>
		<div class="flex items-center gap-2 px-4 py-2.5 text-xs text-gray-500 dark:text-gray-400">
			{#if spinner}
				<EosIconsLoading class="text-gray-400" />
				<span class={runState.status === "loading" ? "router-shimmer" : ""}>
					{runState.status === "loading" ? m["chat.run.starting"]() : m["chat.run.running"]()}
				</span>
			{:else if runState.status === "error"}
				<CarbonWarningAlt class="text-amber-500 dark:text-amber-400" />
				<span>{runState.outcome ? m["chat.run.finished_errors"]() : m["chat.run.failed"]()}</span>
			{:else}
				<CarbonCheckmark class="text-green-600 dark:text-green-500" />
				<span>{duration ? m["chat.run.finished_in"]({ duration }) : m["chat.run.finished"]()}</span>
			{/if}
		</div>
		{@render before?.()}
		{#if outputBlocks.length > 0 || runState.sandboxError}
			<div class="space-y-2 px-4 pb-3">{@render blocksView()}</div>
		{/if}
		{#if showFiles}
			<RunFiles state={runState} {inPanel} />
		{/if}
	</div>
{/if}
