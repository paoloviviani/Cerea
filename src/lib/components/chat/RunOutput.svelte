<script lang="ts">
	import EosIconsLoading from "~icons/eos-icons/loading";
	import CarbonWarningAlt from "~icons/carbon/warning-alt";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonDocument from "~icons/carbon/document";
	import { getExecutionSession } from "$lib/utils/execution/runtime";
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

	let downloading = $state<string | null>(null);
	let downloadError = $state<string | null>(null);

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	/**
	 * Pull one runtime file out of the sandbox and hand it to the browser as
	 * a download. The bytes travel as a transferable ArrayBuffer — never
	 * through the capped text output — and land in a blob URL the anchor
	 * consumes, so nothing generated lingers in a readable page context.
	 */
	async function downloadFile(path: string): Promise<void> {
		const session = getExecutionSession();
		if (!session) return;
		downloading = path;
		downloadError = null;
		try {
			const data = await session.readFile(path);
			const name = path.split("/").pop() || "download";
			const url = URL.createObjectURL(new Blob([data]));
			try {
				const link = window.document.createElement("a");
				link.href = url;
				link.download = name;
				link.rel = "noopener";
				window.document.body.appendChild(link);
				link.click();
				link.remove();
			} finally {
				URL.revokeObjectURL(url);
			}
		} catch (err) {
			// The worker filesystem dies with the page load: a file listed by
			// an earlier run may be gone already, and re-running the code is
			// the way back — the message says exactly that.
			downloadError =
				err instanceof Error
					? err.message
					: "that file is no longer in the runtime; run the code again to recreate it";
		} finally {
			downloading = null;
		}
	}

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
								<li
									class="flex items-center gap-2 rounded-lg bg-gray-100 px-2 py-1.5 text-xs dark:bg-gray-800/70"
								>
									<CarbonDocument class="size-3.5 shrink-0 text-gray-400" />
									<span class="min-w-0 flex-1 truncate font-mono" title={file.path}>
										{file.path.split("/").pop()}
									</span>
									<span class="shrink-0 text-gray-400">{formatSize(file.size)}</span>
									<button
										onclick={() => downloadFile(file.path)}
										disabled={downloading === file.path}
										class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-blue-600 hover:bg-blue-500/10 disabled:opacity-50 dark:text-blue-400"
										aria-label={`Download ${file.path.split("/").pop()}`}
									>
										<CarbonDownload class="size-3.5" />
										{downloading === file.path ? "…" : "Download"}
									</button>
								</li>
							{/each}
						</ul>
						{#if downloadError}
							<p class="text-xs text-amber-600 dark:text-amber-400">{downloadError}</p>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/if}
