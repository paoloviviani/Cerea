<script lang="ts">
	import CopyToClipBoardBtn from "./CopyToClipBoardBtn.svelte";
	import DOMPurify from "isomorphic-dompurify";
	import HtmlPreviewModal from "./HtmlPreviewModal.svelte";
	import PlayFilledAlt from "~icons/carbon/play-filled-alt";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import RunOutput from "./chat/RunOutput.svelte";
	import FileCard from "./chat/FileCard.svelte";
	import { getArtifactsContext } from "$lib/utils/artifactsContext";
	import { parseFileBlockInfo } from "$lib/utils/fileBlock";
	import { chatRunKey } from "$lib/utils/execution/keys";
	import { getRunsStore } from "$lib/utils/execution/runs.svelte";

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

	// ----- direct-emission file blocks -----
	// A fence whose info string names a file (```markdown title=report.md) is
	// the model handing over a finished text file: the block content is the
	// file's bytes, emitted verbatim. Zero execution — nothing here runs code
	// and no sandbox is touched; the card's bytes travel client-side from the
	// message content, which is also why they survive reload, the Markdown
	// export and share links by construction (sandbox files do not).
	// While the fence is still streaming it renders as an ordinary code block,
	// and the card replaces it only once the fence closes — no partial-box
	// flicker. A fence left unclosed by a stopped run renders the card with
	// the bytes that did arrive: partial output is still what the user saw.
	const fileBlock = $derived(parseFileBlockInfo(language));

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
		// A titled block is a file deliverable, never a program to run — even
		// when its language is python (the card replaces the whole execution
		// surface). The membership check below would already exclude it because
		// the info string carries the annotation; the explicit guard keeps that
		// invariant independent of how the string is shaped.
		!fileBlock && PYTHON_LANGUAGES.has(language.trim().toLowerCase()) && rawCode.length > 0
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

	/**
	 * File-first presentation, guarded: when the run produced files, the file
	 * is (at least part of) the deliverable, so the code folds behind a
	 * disclosure and the RunOutput files below carry the result. When the run
	 * produced no files the code IS the deliverable and renders exactly as
	 * before — nothing is ever removed, only folded, and one click restores
	 * it.
	 */
	let generatedFileCount = $derived(runState?.outputFiles?.length ?? 0);
</script>

<div class="group relative my-4 rounded-lg">
	{#if fileBlock && !loading}
		<ul class="not-prose">
			<FileCard file={{ path: fileBlock.filename, size: 0 }} inlineContent={rawCode} />
		</ul>
	{:else}
		<div class="pointer-events-none sticky top-0 w-full">
			<div
				class="pointer-events-auto absolute flex items-center gap-1.5 {generatedFileCount > 0
					? 'top-px right-5'
					: 'top-2 right-2 md:top-3 md:right-3'}"
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
		{#snippet codeFence()}
			<pre class="scrollbar-custom overflow-auto px-5 font-mono transition-[height]"><code
					><!-- eslint-disable svelte/no-at-html-tags -->{@html sanitizedCode}</code
				></pre>
		{/snippet}

		{#if generatedFileCount > 0}
			<details
				class="mx-5 mb-2 rounded-lg border border-gray-200/70 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-700/70 dark:text-gray-400"
			>
				<summary class="cursor-pointer">
					View code · {generatedFileCount} generated file{generatedFileCount === 1 ? "" : "s"} below
				</summary>
				<div class="pt-1">{@render codeFence()}</div>
			</details>
		{:else}
			{@render codeFence()}
		{/if}

		<RunOutput state={runState} class="mx-5 mb-3" />
	{/if}

	{#if previewOpen}
		<HtmlPreviewModal
			html={rawCode}
			onclose={() => (previewOpen = false)}
			onsend={artifactsContext?.requestFix}
		/>
	{/if}
</div>
