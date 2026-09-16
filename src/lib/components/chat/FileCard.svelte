<script lang="ts">
	import { onDestroy } from "svelte";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonDocument from "~icons/carbon/document";
	import { getExecutionSession } from "$lib/utils/execution/runtime";

	/**
	 * One file a run generated, as a deliverable rather than a log line: name
	 * and size always, a download that pulls the bytes out of the sandbox,
	 * and an inline preview where the type allows one. Used by RunOutput, so
	 * chat blocks and artifact code cells present files identically.
	 *
	 * The same card also presents direct-emission file blocks (CodeBlock):
	 * there `inlineContent` carries the file's own text and no sandbox exists
	 * — the bytes travel client-side from the message content, and the docx
	 * preview (which runs Python in the sandbox) is not offered. Both modes
	 * share every class and the preview logic, so the two cards cannot drift.
	 *
	 * Previews are fetched lazily on first expand and kept for the session:
	 * text decodes in-page, images and PDFs render from a blob URL, and Word
	 * documents go through a tiny in-sandbox extraction (the standard
	 * library's zipfile — no new dependency, no server round trip). Anything
	 * else is metadata plus the download, which is always available.
	 */
	interface Props {
		file: { path: string; size: number };
		/**
		 * Direct-emission mode: the bytes are this message text itself (a
		 * titled file block), not a sandbox file. When set, `file.size` is
		 * ignored (the byte length is derived) and the execution sandbox is
		 * never touched.
		 */
		inlineContent?: string;
		/**
		 * Persisted-deliverable mode: bytes come from the server-side output
		 * store (`/conversation/[id]/code-execution/output/[sha256]`) rather
		 * than the worker's in-memory FS — the case on replay, after a reload,
		 * or from another device, where no live sandbox holds this file. Docx
		 * preview (which runs Python in the sandbox) is not offered here.
		 */
		downloadUrl?: string;
	}

	let { file, inlineContent, downloadUrl }: Props = $props();

	const name = $derived(file.path.split("/").pop() || "download");
	const extension = $derived(
		name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : ""
	);

	type PreviewKind = "text" | "image" | "pdf" | "docx" | "none";
	function previewKindFor(extension: string, allowDocx: boolean): PreviewKind {
		if (
			[
				"txt",
				"md",
				"markdown",
				"csv",
				"tsv",
				"json",
				"jsonl",
				"log",
				"py",
				"js",
				"ts",
				"html",
				"xml",
				"yaml",
				"yml",
				"toml",
				"tex",
			].includes(extension)
		)
			return "text";
		if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(extension))
			return "image";
		if (extension === "pdf") return "pdf";
		// The docx preview runs Python in the sandbox, which direct-emission
		// blocks must never touch — and inline content is text, not a zip.
		if (extension === "docx") return allowDocx ? "docx" : "none";
		return "none";
	}

	const previewKind = $derived(
		previewKindFor(extension, inlineContent === undefined && downloadUrl === undefined)
	);

	/** UTF-8 byte length of the inline content; only computed in direct-emission mode. */
	const inlineSize = $derived(
		inlineContent === undefined ? 0 : new TextEncoder().encode(inlineContent).length
	);
	const size = $derived(inlineContent === undefined ? file.size : inlineSize);

	let downloading = $state(false);
	let downloadError = $state<string | null>(null);

	let previewOpen = $state(false);
	let previewBusy = $state(false);
	let previewError = $state<string | null>(null);
	let previewText = $state<string | null>(null);
	let previewUrl = $state<string | null>(null);

	function revokePreviewUrl(): void {
		if (previewUrl) {
			URL.revokeObjectURL(previewUrl);
			previewUrl = null;
		}
	}

	onDestroy(revokePreviewUrl);

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	/**
	 * The card's two byte sources: direct-emission blocks carry their own text
	 * (the block content IS the file), sandbox files are read out of the
	 * runtime. Both land as transferable bytes — never through the capped
	 * text output.
	 */
	async function readBytes(): Promise<ArrayBuffer | Uint8Array<ArrayBuffer>> {
		if (inlineContent !== undefined) return new TextEncoder().encode(inlineContent);
		if (downloadUrl !== undefined) {
			const res = await fetch(downloadUrl);
			if (!res.ok) throw new Error("that file is no longer available");
			return await res.arrayBuffer();
		}
		const session = getExecutionSession();
		if (!session) throw new Error("the execution sandbox is not available in this context");
		return session.readFile(file.path);
	}

	/**
	 * Hand the bytes to the browser as a download: they travel as transferable
	 * bytes — never through the capped text output — and land in a blob URL
	 * the anchor consumes.
	 */
	async function downloadFile(): Promise<void> {
		downloading = true;
		downloadError = null;
		try {
			const data = await readBytes();
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
			// the way back — the message says exactly that. Direct-emission
			// blocks carry their own bytes and cannot lose them this way.
			downloadError =
				err instanceof Error
					? err.message
					: inlineContent !== undefined || downloadUrl !== undefined
						? "the download failed"
						: "that file is no longer in the runtime; run the code again to recreate it";
		} finally {
			downloading = false;
		}
	}

	/**
	 * The preview snippet for a Word document. Runs in the sandbox itself so
	 * no zip dependency or server round trip is needed; read-only, writes
	 * nothing, and prints at most PREVIEW_CHARS so it always fits the output
	 * cap. The path travels as a JSON string, which is a valid Python string
	 * literal — never interpolated raw.
	 */
	function docxPreviewCode(path: string, maxChars: number): string {
		return [
			"import zipfile, xml.etree.ElementTree as ET",
			`_z = zipfile.ZipFile(${JSON.stringify(path)})`,
			"_root = ET.fromstring(_z.read('word/document.xml'))",
			"_ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'",
			"_paras = []",
			"for _p in _root.iter(f'{_ns}p'):",
			"    _paras.append(''.join(_t.text or '' for _t in _p.iter(f'{_ns}t')))",
			`print('\\n'.join(_paras)[:${maxChars}])`,
		].join("\n");
	}

	const PREVIEW_TEXT_CHARS = 4000;

	async function togglePreview(): Promise<void> {
		if (previewOpen) {
			previewOpen = false;
			revokePreviewUrl();
			return;
		}
		previewOpen = true;
		if (previewText !== null || previewUrl !== null || previewBusy) return;
		previewBusy = true;
		previewError = null;
		try {
			if (previewKind === "text") {
				if (size > 2 * 1024 * 1024) {
					throw new Error("too large to preview — download it to read the whole file");
				}
				const data = await readBytes();
				const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
				previewText =
					text.length > PREVIEW_TEXT_CHARS
						? `${text.slice(0, PREVIEW_TEXT_CHARS)}\n\n… showing the first ${(PREVIEW_TEXT_CHARS / 1000).toFixed(0)}k of ${formatSize(size)}`
						: text;
			} else if (previewKind === "image" || previewKind === "pdf") {
				const data = await readBytes();
				revokePreviewUrl();
				previewUrl = URL.createObjectURL(new Blob([data]));
			} else if (previewKind === "docx") {
				// Only reachable in sandbox mode: direct-emission blocks never get
				// a docx preview kind (their content is text, not a zip).
				const session = getExecutionSession();
				if (!session) throw new Error("the execution sandbox is not available in this context");
				const outcome = await session.run(docxPreviewCode(file.path, PREVIEW_TEXT_CHARS));
				if (!outcome.ok) throw new Error(outcome.error ?? "the preview run failed");
				previewText = outcome.stdout.trim() === "" ? "(no readable text found)" : outcome.stdout;
			}
		} catch (err) {
			previewError =
				err instanceof Error ? err.message : "the preview is unavailable; the download still works";
		} finally {
			previewBusy = false;
		}
	}
</script>

<li class="rounded-lg bg-gray-100 px-2 py-1.5 text-xs dark:bg-gray-800/70">
	<div class="flex items-center gap-2">
		<CarbonDocument class="size-3.5 shrink-0 text-gray-400" />
		<span class="min-w-0 flex-1 truncate font-mono" title={file.path}>
			{name}
		</span>
		<span class="shrink-0 text-gray-400">{formatSize(size)}</span>
		{#if previewKind !== "none"}
			<button
				onclick={togglePreview}
				class="shrink-0 rounded-md px-1.5 py-0.5 text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
				aria-expanded={previewOpen}
				aria-label={previewOpen ? `Hide preview of ${name}` : `Preview ${name}`}
			>
				{previewBusy ? "…" : previewOpen ? "Hide" : "Preview"}
			</button>
		{/if}
		<button
			onclick={downloadFile}
			disabled={downloading}
			class="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-blue-600 hover:bg-blue-500/10 disabled:opacity-50 dark:text-blue-400"
			aria-label={`Download ${name}`}
		>
			<CarbonDownload class="size-3.5" />
			{downloading ? "…" : "Download"}
		</button>
	</div>
	{#if downloadError}
		<p class="pt-1 text-xs text-amber-600 dark:text-amber-400">{downloadError}</p>
	{/if}
	{#if previewOpen}
		<div class="pt-1.5">
			{#if previewBusy}
				<p class="text-xs text-gray-400">Loading preview…</p>
			{:else if previewError}
				<p class="text-xs text-amber-600 dark:text-amber-400">{previewError}</p>
			{:else if previewKind === "image" && previewUrl}
				<img
					src={previewUrl}
					alt={`Preview of ${name}`}
					class="scrollbar-custom max-h-80 overflow-auto rounded-lg"
				/>
			{:else if previewKind === "pdf" && previewUrl}
				<iframe
					src={previewUrl}
					title={`Preview of ${name}`}
					class="h-80 w-full rounded-lg bg-white"
				></iframe>
			{:else if previewText !== null}
				<pre
					class="scrollbar-custom max-h-60 overflow-y-auto rounded-lg bg-gray-50 p-2 font-mono text-xs break-words whitespace-pre-wrap text-gray-800 dark:bg-gray-900 dark:text-gray-200">{previewText}</pre>
			{/if}
		</div>
	{/if}
</li>
