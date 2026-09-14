<script lang="ts">
	import EosIconsLoading from "~icons/eos-icons/loading";
	import CarbonWarningAlt from "~icons/carbon/warning-alt";
	import CarbonCheckmark from "~icons/carbon/checkmark";
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

	let { state, class: className = "" }: Props = $props();

	let spinner = $derived(
		!!state &&
			(state.status === "loading" || state.status === "running" || state.status === "queued")
	);

	type OutputBlock = { label: string; tone: "plain" | "error"; text: string };

	let outputBlocks = $derived.by((): OutputBlock[] => {
		const blocks: OutputBlock[] = [];
		const outcome = state?.outcome;
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

{#if state}
	<div class="rounded-lg border border-gray-200/70 dark:border-gray-700/70 {className}">
		<div
			class="flex items-center gap-1.5 border-b border-gray-200/70 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-700/70 dark:text-gray-400"
		>
			{#if spinner}
				<EosIconsLoading class="text-gray-400" />
				<span class={state.status === "loading" ? "router-shimmer" : ""}>
					{state.status === "loading" ? "Starting Python" : "Running"}
				</span>
			{:else if state.status === "error"}
				<CarbonWarningAlt class="text-amber-500 dark:text-amber-400" />
				<span>{state.outcome ? "Finished with errors" : "Execution failed"}</span>
			{:else}
				<CarbonCheckmark class="text-green-600 dark:text-green-500" />
				<span>Finished</span>
			{/if}
		</div>
		{#if outputBlocks.length > 0 || state.sandboxError}
			<div class="space-y-2 px-3 py-2">
				{#if state.sandboxError}
					<pre
						class="scrollbar-custom max-h-60 overflow-y-auto rounded-lg bg-amber-50 p-2 font-mono text-xs break-all whitespace-pre-wrap text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">{state.sandboxError}</pre>
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
			</div>
		{/if}
	</div>
{/if}
