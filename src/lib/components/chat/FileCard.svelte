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
	 * Previews are fetched lazily on first expand and kept for the session:
	 * text decodes in-page, images and PDFs render from a blob URL, and Word
	 * documents go through a tiny in-sandbox extraction (the standard
	 * library's zipfile — no new dependency, no server round trip). Anything
	 * else is metadata plus the download, which is always available.
	 */
	interface Props {
		file: { path: string; size: number };
	}

	let { file }: Props = $props();

	const name = $derived(file.path.split("/").pop() || "download");
	const extension = $derived(
		name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : ""
	);

	type PreviewKind = "text" | "image" | "pdf" | "docx" | "none";
	function previewKindFor(extension: string): PreviewKind {
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
		if (extension === "docx") return "docx";
		return "none";
	}

	const previewKind = $derived(previewKindFor(extension));

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

	async function readBytes(): Promise<ArrayBuffer> {
		const session = getExecutionSession();
		if (!session) throw new Error("the execution sandbox is not available in this context");
		return session.readFile(file.path);
	}

	/**
	 * Pull the file out of the sandbox and hand it to the browser as a
	 * download. Bytes travel as a transferable ArrayBuffer — never through
	 * the capped text output — and land in a blob URL the anchor consumes.
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
			// the way back — the message says exactly that.
			downloadError =
				err instanceof Error
					? err.message
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
			const session = getExecutionSession();
			if (!session) throw new Error("the execution sandbox is not available in this context");
			if (previewKind === "text") {
				if (file.size > 2 * 1024 * 1024) {
					throw new Error("too large to preview — download it to read the whole file");
				}
				const data = await session.readFile(file.path);
				const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
				previewText =
					text.length > PREVIEW_TEXT_CHARS
						? `${text.slice(0, PREVIEW_TEXT_CHARS)}\n\n… showing the first ${(PREVIEW_TEXT_CHARS / 1000).toFixed(0)}k of ${formatSize(file.size)}`
						: text;
			} else if (previewKind === "image" || previewKind === "pdf") {
				const data = await session.readFile(file.path);
				revokePreviewUrl();
				previewUrl = URL.createObjectURL(new Blob([data]));
			} else if (previewKind === "docx") {
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
		<span class="shrink-0 text-gray-400">{formatSize(file.size)}</span>
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
