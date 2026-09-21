<script lang="ts">
	import { onDestroy } from "svelte";
	import DOMPurify from "isomorphic-dompurify";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonDocument from "~icons/carbon/document";
	import PlayFilledAlt from "~icons/carbon/play-filled-alt";
	import { getExecutionSession } from "$lib/utils/execution/runtime";
	import { sidePane } from "$lib/stores/sidePane.svelte";
	import {
		CODE_CARD_SURFACE,
		CODE_PILL_BUTTON,
		CODE_ICON_BUTTON,
		CODE_ICON_SIZE,
	} from "../codeChrome";

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
	 * text decodes in-page, images and PDFs render from a blob URL. Word
	 * documents render as formatted HTML in the side panel (mammoth, vendored
	 * and loaded on demand): a text extraction was the previous preview and it
	 * answered "what words" while looking nothing like the document — the panel
	 * shows headings, lists, tables and emphasis, on bytes from any source, so
	 * the preview survives reloads. Anything else is metadata plus the download,
	 * which is always available.
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
	function previewKindFor(extension: string, isInlineContent: boolean): PreviewKind {
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
		// Word documents render through mammoth from fetched bytes, so every
		// byte source qualifies — live sandbox, persisted store, replay. Only
		// direct-emission blocks are excluded, and those cannot be a docx
		// anyway: inline content is text, not a zip.
		if (extension === "docx") return isInlineContent ? "none" : "docx";
		return "none";
	}

	/**
	 * Content type for the preview blob. Chrome's PDF viewer only engages for
	 * application/pdf: a typeless blob navigated in the preview iframe
	 * downloads instead of rendering, which is exactly the blank-frame-plus-
	 * download failure. Images sniff either way, but an explicit type costs
	 * nothing and states what the bytes are.
	 */
	function previewMimeType(extension: string): string {
		switch (extension) {
			case "pdf":
				return "application/pdf";
			case "png":
				return "image/png";
			case "jpg":
			case "jpeg":
				return "image/jpeg";
			case "gif":
				return "image/gif";
			case "webp":
				return "image/webp";
			case "svg":
				return "image/svg+xml";
			case "bmp":
				return "image/bmp";
			case "avif":
				return "image/avif";
			default:
				return "application/octet-stream";
		}
	}

	const previewKind = $derived(previewKindFor(extension, inlineContent !== undefined));

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
	 * Rendered-document preview for a Word file: bytes from any source (live
	 * sandbox, persisted store, replay) through mammoth to semantic HTML,
	 * sanitized, shown in the side panel. Loaded on demand so the converter
	 * never enters the bundle of a conversation without a docx in it.
	 */
	const DOCX_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
	// A pdf travels whole (the viewer needs every byte) as a data: URL, so
	// the same cap applies: base64 inflates a third on top.
	const PDF_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

	/**
	 * Rendered-document preview for a PDF: bytes from any source, framed in
	 * the side panel like every other rendered view. A data: URL rather than
	 * a blob URL so there is no object lifetime to manage across panel
	 * open/close — and typed application/pdf, because a typeless blob
	 * navigated in a frame downloads instead of rendering.
	 */
	async function openPdfPreview(): Promise<void> {
		previewBusy = true;
		previewError = null;
		try {
			const data = await readBytes();
			const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
			if (bytes.byteLength > PDF_PREVIEW_MAX_BYTES) {
				throw new Error("too large to preview — download it to read the whole document");
			}
			const dataUrl: string = await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(reader.result as string);
				reader.onerror = () =>
					reject(reader.error ?? new Error("the preview is unavailable; the download still works"));
				reader.readAsDataURL(
					new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)], {
						type: "application/pdf",
					})
				);
			});
			sidePane.openPreview({ kind: "pdf", title: name, content: dataUrl });
		} catch (err) {
			previewError =
				err instanceof Error ? err.message : "the preview is unavailable; the download still works";
			previewOpen = true;
		} finally {
			previewBusy = false;
		}
	}
	async function openDocxPreview(): Promise<void> {
		previewBusy = true;
		previewError = null;
		try {
			const data = await readBytes();
			const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
			if (bytes.byteLength > DOCX_PREVIEW_MAX_BYTES) {
				throw new Error("too large to preview — download it to read the whole document");
			}
			const mammoth = await import("mammoth");
			// slice() copies exactly the viewed range: bytes.buffer may overhang
			// it (transferable slices), and mammoth would parse the slack too.
			const { value } = await mammoth.convertToHtml({ arrayBuffer: bytes.slice().buffer });
			// Mammoth emits an unstyled fragment; the wrapper gives it readable
			// typography inside the preview frame (inline <style> is allowed by
			// the preview CSP). Sanitized like every other model-authored HTML
			// before it reaches the panel — the sandboxed iframe is the second
			// layer, not the only one.
			const document = `<style>
				.docx-preview{font:14px/1.6 system-ui,sans-serif;color:#111;max-width:65ch;margin:0 auto;padding:24px}
				.docx-preview table{border-collapse:collapse;margin:12px 0}
				.docx-preview th,.docx-preview td{border:1px solid #ccc;padding:4px 8px;text-align:left}
				.docx-preview img{max-width:100%}
			</style><div class="docx-preview">${value}</div>`;
			sidePane.openPreview({
				kind: "html",
				title: name,
				content: DOMPurify.sanitize(document),
			});
		} catch (err) {
			previewError =
				err instanceof Error ? err.message : "the preview is unavailable; the download still works";
			// A failed render still needs somewhere visible to land: reuse the
			// inline error slot the other kinds share.
			previewOpen = true;
		} finally {
			previewBusy = false;
		}
	}

	const PREVIEW_TEXT_CHARS = 4000;

	async function togglePreview(): Promise<void> {
		if (previewOpen) {
			previewOpen = false;
			revokePreviewUrl();
			return;
		}
		// A rendered document belongs in the side panel with every other
		// rendered view — not in the inline expander, which stays for the
		// small text/image/pdf snippets.
		if (previewKind === "docx") {
			await openDocxPreview();
			return;
		}
		if (previewKind === "pdf") {
			await openPdfPreview();
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
			} else if (previewKind === "image") {
				const data = await readBytes();
				revokePreviewUrl();
				previewUrl = URL.createObjectURL(new Blob([data], { type: previewMimeType(extension) }));
			}
		} catch (err) {
			previewError =
				err instanceof Error ? err.message : "the preview is unavailable; the download still works";
		} finally {
			previewBusy = false;
		}
	}
</script>

<li class={CODE_CARD_SURFACE + " px-2 py-1.5 text-xs"}>
	<div class="flex items-center gap-2">
		<CarbonDocument class="size-3.5 shrink-0 text-gray-400" />
		<span class="min-w-0 flex-1 truncate font-mono" title={file.path}>
			{name}
		</span>
		<span class="shrink-0 text-gray-400">{formatSize(size)}</span>
		{#if previewKind !== "none"}
			<button
				onclick={togglePreview}
				class={CODE_PILL_BUTTON}
				aria-expanded={previewOpen}
				aria-label={previewOpen ? `Hide preview of ${name}` : `Preview ${name}`}
			>
				{#if previewBusy}
					…
				{:else}
					<PlayFilledAlt class="size-3.5" />
					{previewOpen ? "Hide" : "Preview"}
				{/if}
			</button>
		{/if}
		<button
			onclick={downloadFile}
			disabled={downloading}
			class={CODE_ICON_BUTTON}
			title={`Download ${name}`}
			aria-label={`Download ${name}`}
		>
			<CarbonDownload class={CODE_ICON_SIZE} />
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
			{:else if previewText !== null}
				<pre
					class="scrollbar-custom max-h-60 overflow-y-auto rounded-lg border-[0.5px] border-gray-200/70 bg-white p-2 font-mono text-xs break-words whitespace-pre-wrap text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">{previewText}</pre>
			{/if}
		</div>
	{/if}
</li>
