<script lang="ts">
	import EosIconsLoading from "~icons/eos-icons/loading";
	import CarbonWarningAlt from "~icons/carbon/warning-alt";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import FileCard from "./FileCard.svelte";
	import type { RunState } from "$lib/utils/execution/runs.svelte";

	/**
	 * Shared presentation of one code execution outcome: a status strip and the
	 * captured output blocks. Used under chat code blocks and in the artifact
	 * panel's code view, so both surfaces report the runtime identically.
	 */
	interface Props {
		state?: RunState;
		/** Wrapper classes; the chat block adds margins, the panel none. */
		class?: string;
	}

	let { state: runState, class: className = "" }: Props = $props();
	// Bound off `state`: a `state` binding in scope turns every `$state` rune
	// into a store reference (store_rune_conflict), so the runes below would
	// stop compiling. Call sites still pass `state={...}`.

	let spinner = $derived(
		!!runState &&
			(runState.status === "loading" ||
				runState.status === "running" ||
				runState.status === "queued")
	);

	type OutputBlock = { label: string; tone: "plain" | "error"; text: string };

	let outputBlocks = $derived.by((): OutputBlock[] => {
		const blocks: OutputBlock[] = [];
		const outcome = runState?.outcome;
		if (!outcome) return blocks;
		if (outcome.stdout) blocks.push({ label: "Output", tone: "plain", text: outcome.stdout });
		if (outcome.stderr)
			blocks.push({
				label: "Stderr",
				tone: outcome.ok ? "plain" : "error",
				text: outcome.stderr,
			});
		if (!outcome.ok && outcome.error)
			blocks.push({ label: "Error", tone: "error", text: outcome.error });
		else if (outcome.ok && outcome.result)
			blocks.push({ label: "Result", tone: "plain", text: outcome.result });
		return blocks;
	});
</script>

{#if runState}
	<div class="rounded-lg border border-gray-200/70 dark:border-gray-700/70 {className}">
		<div
			class="flex items-center gap-1.5 border-b border-gray-200/70 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-700/70 dark:text-gray-400"
		>
			{#if spinner}
				<EosIconsLoading class="text-gray-400" />
				<span class={runState.status === "loading" ? "router-shimmer" : ""}>
					{runState.status === "loading" ? "Starting Python" : "Running"}
				</span>
			{:else if runState.status === "error"}
				<CarbonWarningAlt class="text-amber-500 dark:text-amber-400" />
				<span>{runState.outcome ? "Finished with errors" : "Execution failed"}</span>
			{:else}
				<CarbonCheckmark class="text-green-600 dark:text-green-500" />
				<span>Finished</span>
			{/if}
		</div>
		{#if outputBlocks.length > 0 || runState.sandboxError || (runState.outputFiles?.length ?? 0) > 0}
			<div class="space-y-2 px-3 py-2">
				{#if runState.sandboxError}
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
								: 'bg-gray-100 dark:bg-gray-800/70'} p-2 font-mono text-xs break-all whitespace-pre-wrap">{block.text}</pre>
					</div>
				{/each}
				{#if runState.outputFiles && runState.outputFiles.length > 0}
					<div class="space-y-1">
						<div class="text-[10px] font-semibold text-gray-400 uppercase dark:text-gray-500">
							Files
						</div>
						<ul class="space-y-1">
							{#each runState.outputFiles as file (file.path)}
								<FileCard {file} />
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
