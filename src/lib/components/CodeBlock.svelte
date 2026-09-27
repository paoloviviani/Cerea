<script lang="ts">
	import CopyToClipBoardBtn from "./CopyToClipBoardBtn.svelte";
	import DOMPurify from "isomorphic-dompurify";
	import PlayFilledAlt from "~icons/carbon/play-filled-alt";
	import CarbonDocument from "~icons/carbon/document";
	import CarbonDownload from "~icons/carbon/download";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import RunOutput from "./chat/RunOutput.svelte";
	import {
		parseFileBlockInfo,
		downloadTextAsFile,
		fileBlockByteSize,
		formatFileSize,
	} from "$lib/utils/fileBlock";
	import { sidePane } from "$lib/stores/sidePane.svelte";
	import { CODE_PILL_BUTTON, CODE_ICON_BUTTON } from "./codeChrome";
	import { chatRunKey } from "$lib/utils/execution/keys";
	import { getRunsStore, type RunState } from "$lib/utils/execution/runs.svelte";
	import { base } from "$app/paths";
	import { getMessageRunContext } from "$lib/utils/execution/messageContext";
	import { recordRunFiles, uploadRunFiles } from "$lib/utils/execution/runFiles";
	import { runFiles } from "$lib/stores/runFiles.svelte";

	interface Props {
		code?: string;
		rawCode?: string;
		loading?: boolean;
		/**
		 * Whether the message this fence belongs to is the one this tab is
		 * currently generating — unlike `loading`, this stays true even once
		 * the fence itself closes (MarkdownBlock computes `loading` as
		 * `loading && !token.isClosed`, so a fence that arrives already closed
		 * — the whole answer in one final chunk, no streamed tokens — makes
		 * `loading` false from this component's very first render). Used only
		 * to mark a fence as having been seen live; auto-run itself still
		 * waits on `loading` to know the fence is actually closed.
		 */
		messageLoading?: boolean;
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
		messageLoading = false,
		language = "",
		autorun = false,
	}: Props = $props();

	// ----- direct-emission file blocks -----
	// A fence whose info string names a file (```markdown title=report.md) is
	// the model handing over a finished text file: the block content is the
	// file's bytes, emitted verbatim. Zero execution — nothing here runs code
	// and no sandbox is touched; the bytes travel client-side from the message
	// content, which is also why they survive reload, the Markdown export and
	// share links by construction (sandbox files do not).
	// While the fence is still streaming it renders as an ordinary code block,
	// and the filename header appears only once the fence closes — no partial
	// flicker. A fence left unclosed by a stopped run shows the bytes that did
	// arrive: partial output is still what the user saw.
	// The header is the only thing a titled fence adds: the body below (code,
	// Preview/Copy/Run buttons, run output) is shared with untitled fences, so
	// the same content previews the same way however the model emitted it.
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

	// The language token before any title= annotation ("mermaid" from
	// "mermaid title=diagram.mmd"). Mermaid is the one preview decided by
	// language rather than content: a diagram needs no doctype to render.
	const previewLanguage = $derived((fileBlock?.language ?? language).trim().toLowerCase());
	const isMermaid = $derived(previewLanguage === "mermaid");

	let showPreview = $derived(hasStrictHtml5Doctype(rawCode) || isSvgDocument(rawCode) || isMermaid);

	/**
	 * Open the fence in the side pane instead of a fullscreen modal: every
	 * renderable block — titled or not — lands on the same surface through
	 * the same sandboxed builders. SVG travels as "html" (an SVG document is
	 * valid inline HTML, and that is also what the retired modal passed).
	 */
	function openPreview() {
		if (loading || !showPreview) return;
		sidePane.openPreview({
			kind: isMermaid ? "mermaid" : "html",
			title: fileBlock?.filename ?? "Preview",
			content: rawCode,
		});
	}

	/**
	 * Download a directly-emitted block under its annotated filename. The
	 * bytes are this message's own text, so unlike a sandbox file's download
	 * this one cannot go stale after a reload.
	 */
	function downloadFile() {
		if (!fileBlock) return;
		downloadTextAsFile(fileBlock.filename, rawCode);
	}

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

	// Auto-run fires exactly once, for a fence that first appeared as part of
	// the live turn this tab is generating — whether it streamed in token by
	// token or (some models, sometimes) arrived whole in the final update.
	// Blocks loaded from history are born closed with `messageLoading` false,
	// so they keep the manual affordance — a page load must not re-execute
	// every snippet a conversation ever contained.
	//
	// The "seen live" signal lives on the store, keyed by runKey, rather than
	// in a local `$state` here: the containing message's each-key swaps at
	// settle (`stream-${index}` → `block.id`, see MarkdownRenderer.svelte),
	// remounting this component right at the moment `loading` flips false — a
	// local flag would reset to unset on the fresh instance and auto-run
	// would never fire. `runsStore.run` is itself idempotent per key
	// (re-renders, and so a remount too, never re-execute an already-run
	// key), so marking-and-triggering on every render here is safe: it fires
	// the run once, the first time some instance sees both signals true,
	// remount or not.
	//
	// Marked on `messageLoading`, not `loading`: `loading` is
	// `messageLoading && !token.isClosed` (see MarkdownBlock.svelte), so an
	// answer that arrives whole — fence already closed — makes `loading`
	// false from this component's very first render, and marking on it would
	// never fire. `messageLoading` stays true across that same render,
	// because it does not know or care whether any individual fence inside
	// the message has closed yet.
	$effect(() => {
		if (messageLoading && runsStore && runKey) runsStore.markSeenStreaming(streamedKey());
	});
	$effect(() => {
		if (!autorun || loading || !runsStore || !runKey) return;
		if (!runsStore.hasSeenStreaming(streamedKey())) return;
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
	// ----- keeping the files a run produced -----
	// Every file a run produces is kept and shown the same way, whichever path
	// ran it: once this block's run settles with files, they are uploaded to
	// the conversation's deliverable store (the same one an `execute_code` run
	// uses) and recorded on this message, which is what makes them file
	// artifacts and brings them back after a reload or on another device.
	const messageRun = getMessageRunContext();
	// The "seen streaming" mark is scoped to this conversation: the runs store
	// is tab-wide and a runKey is derived from the code alone, so the same code
	// in another conversation's history must not inherit a mark (it would
	// auto-run a history block if the first one never got to run).
	function streamedKey(): string {
		return `${messageRun?.conversationId ?? ""}|${runKey}`;
	}
	$effect(() => {
		const state = runState;
		const ctx = messageRun;
		// Read every field the claim key and the request need up front,
		// unconditionally: while the turn streams this message carries a
		// client-minted id, swapped for the server's own once the turn's save
		// round-trips and the page re-syncs. Reading `messageId` only past the
		// guards below would leave it untracked whenever an early return was
		// taken (the common case, since most runs never reach the upload), so
		// this effect would never re-fire when the id later changes — reading
		// it here is what makes that swap actually retrigger the attempt.
		const canPersist = ctx?.canPersist ?? false;
		const conversationId = ctx?.conversationId;
		const messageId = ctx?.messageId;
		if (!state || !canPersist || !conversationId || !messageId || !runKey) return;
		if (state.status !== "done" && state.status !== "error") return;
		// The file listing lands after the outcome; wait for it, or there is
		// nothing to upload yet.
		if (!state.outputsCollected || !state.outputFiles?.length) return;
		// Keyed on the message id too: once per run per message in this tab. A
		// remount (scrolling, a re-render) under the same id must not upload
		// again; a run whose record was refused (the id wasn't saved yet) gets
		// a fresh key once the id swaps to the server's, and so a fresh attempt.
		const claimKey = `${messageId}|${runKey}@${state.startedAt}`;
		if (!runFiles.claim(claimKey)) return;
		const key = runKey;
		const listed = state.outputFiles;
		void (async () => {
			const files = await uploadRunFiles(conversationId, listed);
			const update = await recordRunFiles({ conversationId, messageId, runKey: key, files });
			if (update) {
				runFiles.add(messageId, update);
			} else {
				// A 409 (message not saved yet) or any other failure: give up the
				// claim so a later attempt — under the same id, or the server's
				// once it lands — is not permanently blocked by this one.
				runFiles.release(claimKey);
			}
		})();
	});

	// A block from history has no live run, and its sandbox files died with the
	// page that ran it; the stored copies stand in, as for a replayed
	// `execute_code` card.
	let storedState = $derived.by((): RunState | undefined => {
		if (runState || !runKey || !messageRun?.conversationId) return undefined;
		const files = messageRun.storedFiles(runKey);
		if (!files?.length) return undefined;
		return {
			status: "done",
			startedAt: 0,
			persistedFiles: files.map((f) => ({
				name: f.name,
				size: f.size,
				downloadUrl: `${base}/conversation/${messageRun.conversationId}/code-execution/output/${f.sha256}`,
			})),
		};
	});
	let shownState = $derived(runState ?? storedState);

	let generatedFileCount = $derived(
		runState?.outputFiles?.length ?? storedState?.persistedFiles?.length ?? 0
	);
</script>

<div class="group relative my-4 rounded-lg">
	{#if fileBlock && !loading}
		<!-- The filename header is the whole difference between a titled and an
		     untitled fence: same code body, same buttons below. -->
		<div class="flex items-center gap-2 px-5 pt-3 pb-1">
			<CarbonDocument class="size-3.5 shrink-0 text-gray-400" />
			<span class="min-w-0 flex-1 truncate font-mono text-xs" title={fileBlock.filename}>
				{fileBlock.filename}
			</span>
			<span class="shrink-0 text-xs text-gray-400"
				>{formatFileSize(fileBlockByteSize(rawCode))}</span
			>
			<button
				onclick={downloadFile}
				class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
				aria-label={`Download ${fileBlock.filename}`}
			>
				<CarbonDownload class="size-3.5" />
				Download
			</button>
		</div>
	{/if}
	<div class="pointer-events-none sticky top-0 w-full">
		<div
			class="pointer-events-auto absolute flex items-center gap-1.5 {generatedFileCount > 0
				? 'top-px right-5'
				: // A titled fence carries the filename header above the code, so the
					// floating row drops below it instead of sitting on top of it.
					fileBlock && !loading
					? 'top-9 right-2 md:top-10 md:right-3'
					: 'top-2 right-2 md:top-3 md:right-3'}"
		>
			{#if showPreview}
				<button
					class={CODE_PILL_BUTTON}
					disabled={loading}
					onclick={openPreview}
					title={isMermaid ? "Preview diagram" : "Preview HTML"}
					aria-label={isMermaid ? "Preview diagram" : "Preview HTML"}
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
					class={CODE_PILL_BUTTON}
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
			<CopyToClipBoardBtn iconClassNames="size-3" classNames={CODE_ICON_BUTTON} value={rawCode} />
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

	<RunOutput state={shownState} class="mx-5 mb-3" />
</div>
