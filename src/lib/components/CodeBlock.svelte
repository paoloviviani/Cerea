<script lang="ts">
	import CopyToClipBoardBtn from "./CopyToClipBoardBtn.svelte";
	import DOMPurify from "isomorphic-dompurify";
	import HtmlPreviewModal from "./HtmlPreviewModal.svelte";
	import PlayFilledAlt from "~icons/carbon/play-filled-alt";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import CarbonWarningAlt from "~icons/carbon/warning-alt";
	import CarbonCheckmark from "~icons/carbon/checkmark";
	import { getArtifactsContext } from "$lib/utils/artifactsContext";
	import { getRunsStore, chatRunKey } from "$lib/utils/execution/runs.svelte";

	interface Props {
		code?: string;
		rawCode?: string;
		loading?: boolean;
		/** The fence's info string, e.g. "python" — decides runnability. */
		language?: string;
		/**
		 * Model-written blocks may auto-run when their fence closes after
		 * streaming in. False for user-written blocks and history: those keep a
		 * manual Run affordance instead of executing on page load.
		 */
		autorun?: boolean;
	}

	let {
		code = "",
		rawCode = "",
		loading = false,
		language = "",
		autorun = false,
	}: Props = $props();

	// Lets the preview modal send its ask-to-fix message straight to the chat.
	// Undefined outside a chat window (or while it can't accept messages).
	const artifactsContext = getArtifactsContext();

	let previewOpen = $state(false);

	// `code` always comes from our own highlighter (hljs or escapeHTML in
	// marked.ts), which only emits escaped text inside hljs <span> wrappers.
	// While the fence is still streaming (`loading`), the block re-renders on
	// every flush, and re-sanitizing the whole growing block each time is the
	// main-thread hot path of code streaming. Skip DOMPurify during that
	// window only while the html verifiably matches the highlighter's output
	// alphabet (raw `<` may open nothing but a span tag): any other markup —
	// which our highlighter cannot produce — falls back to a full sanitize.
	// Every completed block still gets sanitized as defense in depth.
	const NON_HIGHLIGHTER_TAG = /<(?!\/?span[\s>])/i;
	let sanitizedCode = $derived(
		loading && !NON_HIGHLIGHTER_TAG.test(code) ? code : DOMPurify.sanitize(code)
	);

	function hasStrictHtml5Doctype(input: string): boolean {
		if (!input) return false;
		const withoutBOM = input.replace(/^\uFEFF/, "");
		const trimmed = withoutBOM.trimStart();
		// Strict HTML5 doctype: <!doctype html> with optional whitespace before >
		return /^<!doctype\s+html\s*>/i.test(trimmed);
	}

	function isSvgDocument(input: string): boolean {
		const trimmed = input.trimStart();
		return /^(?:<\?xml[^>]*>\s*)?(?:<!doctype\s+svg[^>]*>\s*)?<svg[\s>]/i.test(trimmed);
	}

	let showPreview = $derived(hasStrictHtml5Doctype(rawCode) || isSvgDocument(rawCode));

	// ----- execution -----
	const PYTHON_LANGUAGES = new Set(["python", "py", "python3", "ipython"]);
	let runnable = $derived(
		PYTHON_LANGUAGES.has(language.trim().toLowerCase()) && rawCode.length > 0
	);

	let runsStore = getRunsStore();
	let runKey = $derived(runnable ? chatRunKey(rawCode) : "");
	let runState = $derived(runsStore && runKey ? runsStore.get(runKey) : undefined);

	// Auto-run fires exactly once, when a fence that streamed in closed. Blocks
	// loaded from history are born closed and never see `loading`, so they keep
	// the manual affordance — a page load must not re-execute every snippet a
	// conversation ever contained.
	let sawStreaming = $state(false);
	$effect(() => {
		if (loading) sawStreaming = true;
	});
	$effect(() => {
		if (!autorun || !sawStreaming || loading || !runsStore || !runKey) return;
		runsStore.run(runKey, rawCode);
	});

	function manualRun() {
		if (!runsStore || !runKey) return;
		runsStore.run(runKey, rawCode, { force: true });
	}

	let runSpinner = $derived(
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
			blocks.push({ label: "Stderr", tone: outcome.ok ? "plain" : "error", text: outcome.stderr });
		if (!outcome.ok && outcome.error)
			blocks.push({ label: "Error", tone: "error", text: outcome.error });
		else if (outcome.ok && outcome.result)
			blocks.push({ label: "Result", tone: "plain", text: outcome.result });
		return blocks;
	});
</script>

<div class="group relative my-4 rounded-lg">
	<div class="pointer-events-none sticky top-0 w-full">
		<div
			class="pointer-events-auto absolute top-2 right-2 flex items-center gap-1.5 md:top-3 md:right-3"
		>
			{#if showPreview}
				<button
					class="btn h-7 gap-1 rounded-lg border px-2 text-xs shadow-xs backdrop-blur-sm transition-none hover:border-gray-500 active:shadow-inner disabled:cursor-not-allowed disabled:opacity-80 dark:border-gray-600 dark:bg-gray-600/50 dark:hover:border-gray-500"
					disabled={loading}
					onclick={() => {
						if (!loading) {
							previewOpen = true;
						}
					}}
					title="Preview HTML"
					aria-label="Preview HTML"
				>
					{#if loading}
						<EosIconsLoading class="size-3.5" />
					{:else}
						<PlayFilledAlt class="size-3.5" />
					{/if}
					Preview
				</button>
			{/if}
			{#if runnable}
				<button
					class="btn h-7 gap-1 rounded-lg border px-2 text-xs shadow-xs backdrop-blur-sm transition-none hover:border-gray-500 active:shadow-inner disabled:cursor-not-allowed disabled:opacity-80 dark:border-gray-600 dark:bg-gray-600/50 dark:hover:border-gray-500"
					disabled={loading || runSpinner}
					onclick={manualRun}
					title="Run this code in the browser sandbox"
					aria-label="Run code"
				>
					{#if runSpinner}
						<EosIconsLoading class="size-3.5" />
					{:else}
						<PlayFilledAlt class="size-3.5" />
					{/if}
					Run
				</button>
			{/if}
			<CopyToClipBoardBtn
				iconClassNames="size-3"
				classNames="btn transition-none rounded-lg border size-7 text-sm shadow-xs dark:bg-gray-600/50 backdrop-blur-sm dark:hover:border-gray-500  active:shadow-inner dark:border-gray-600  hover:border-gray-500"
				value={rawCode}
			/>
		</div>
	</div>
	<pre class="scrollbar-custom overflow-auto px-5 font-mono transition-[height]"><code
			><!-- eslint-disable svelte/no-at-html-tags -->{@html sanitizedCode}</code
		></pre>

	{#if runState}
		<div class="mx-3 mb-3 rounded-lg border border-gray-200/70 dark:border-gray-700/70">
			<div
				class="flex items-center gap-1.5 border-b border-gray-200/70 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-700/70 dark:text-gray-400"
			>
				{#if runSpinner}
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
			{#if outputBlocks.length > 0 || runState.sandboxError}
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
				</div>
			{/if}
		</div>
	{/if}

	{#if previewOpen}
		<HtmlPreviewModal
			html={rawCode}
			onclose={() => (previewOpen = false)}
			onsend={artifactsContext?.requestFix}
		/>
	{/if}
</div>
