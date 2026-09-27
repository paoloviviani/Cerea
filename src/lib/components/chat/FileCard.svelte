<script module lang="ts">
	import { getExecutionSession } from "$lib/utils/execution/runtime";

	/**
	 * The byte-reading and download machinery, shared with FileArtifactCard:
	 * an artifact card presents the same file and must not grow a second copy
	 * of the "which source holds the bytes" logic. The card's own preview and
	 * error presentation stay instance-side.
	 */
	interface FileByteSource {
		file: { path: string; size: number };
		inlineContent?: string;
		downloadUrl?: string;
	}

	/**
	 * The card's byte sources: direct-emission blocks carry their own text
	 * (the block content IS the file), persisted cards fetch the store, the
	 * rest read out of the runtime. All land as transferable bytes — never
	 * through the capped text output.
	 */
	export async function readFileBytes(
		source: FileByteSource
	): Promise<ArrayBuffer | Uint8Array<ArrayBuffer>> {
		if (source.inlineContent !== undefined) return new TextEncoder().encode(source.inlineContent);
		if (source.downloadUrl !== undefined) {
			const res = await fetch(source.downloadUrl);
			if (!res.ok) throw new Error("that file is no longer available");
			return await res.arrayBuffer();
		}
		const session = getExecutionSession();
		if (!session) throw new Error("the execution sandbox is not available in this context");
		return session.readFile(source.file.path);
	}

	/**
	 * Hand bytes to the browser as a download under `name`: they travel as
	 * transferable bytes and land in a blob URL the anchor consumes.
	 */
	export function triggerBrowserDownload(
		name: string,
		data: ArrayBuffer | Uint8Array<ArrayBuffer>
	): void {
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
	}
</script>

<script lang="ts">
	import { onDestroy } from "svelte";
	import DOMPurify from "isomorphic-dompurify";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonDocument from "~icons/carbon/document";
	import PlayFilledAlt from "~icons/carbon/play-filled-alt";
	import { sidePane } from "$lib/stores/sidePane.svelte";
	import {
		FILE_PREVIEW_MAX_BYTES,
		FILE_PREVIEW_TEXT_CHARS,
		FILE_PREVIEW_TEXT_MAX_BYTES,
		fileExtensionOf,
		filePreviewKindFor,
		filePreviewMimeType,
		formatFileSize,
	} from "$lib/utils/filePreview";
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
	 * documents render as formatted HTML in the side panel (docx-preview,
	 * vendored and loaded on demand): a text extraction was the previous
	 * preview and it answered "what words" while looking nothing like the
	 * document — the panel shows the real layout, sections, tables and images,
	 * on bytes from any source, so the preview survives reloads. Anything else
	 * is metadata plus the download, which is always available.
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
	const extension = $derived(fileExtensionOf(name));

	// Renderer selection lives in $lib/utils/filePreview (shared with the
	// artifact panel's file view so the two cannot drift); only the inline
	// flag is local: direct-emission text is never a docx.
	const previewKind = $derived(
		filePreviewKindFor(name, { fromBytes: inlineContent === undefined })
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

	/**
	 * The card's two byte sources: direct-emission blocks carry their own text
	 * (the block content IS the file), sandbox files are read out of the
	 * runtime. Both land as transferable bytes — never through the capped
	 * text output.
	 */
	async function readBytes(): Promise<ArrayBuffer | Uint8Array<ArrayBuffer>> {
		return readFileBytes({ file, inlineContent, downloadUrl });
	}

	/**
	 * Hand the bytes to the browser as a download under the file's name —
	 * shared machinery, see the module script.
	 */
	async function downloadFile(): Promise<void> {
		downloading = true;
		downloadError = null;
		try {
			const data = await readBytes();
			triggerBrowserDownload(name, data);
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
	 * sandbox, persisted store, replay) through docx-preview to the document's
	 * real layout, sanitized, shown in the side panel. Loaded on demand so the
	 * renderer never enters the bundle of a conversation without a docx in it.
	 *
	 * docx-preview renders into a live element, so this runs offscreen in a
	 * detached container and the wrapper's HTML is what travels to the panel —
	 * the renderer's DOM is a means, not the destination.
	 */
	const DOCX_PREVIEW_MAX_BYTES = FILE_PREVIEW_MAX_BYTES;
	// A pdf travels whole (the viewer needs every byte) as a data: URL, so
	// the same cap applies: base64 inflates a third on top.
	const PDF_PREVIEW_MAX_BYTES = FILE_PREVIEW_MAX_BYTES;

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
			const { renderAsync } = await import("docx-preview");
			// slice() copies exactly the viewed range: bytes.buffer may overhang
			// it (transferable slices), and the zip reader would parse the slack
			// too. A Blob rather than a bare buffer because docx-preview's jszip
			// layer reads it through the File API.
			const blob = new Blob([bytes.slice()], {
				type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			});
			const container = window.document.createElement("div");
			await renderAsync(blob, container, undefined, {
				// The docx carries its own fonts, sizes and page geometry —
				// rendering those is the point of the swap; the previous
				// converter emitted a bare semantic fragment that had to be
				// styled by hand instead.
				inWrapper: true,
				ignoreWidth: false,
				ignoreHeight: false,
				ignoreFonts: false,
				breakPages: true,
				// Off by name, not by default: these are 0.x experimental surface,
				// and a throw inside them would lose the whole preview.
				renderHeaders: false,
				renderFooters: false,
				renderFootnotes: false,
				renderEndnotes: false,
				renderChanges: false,
				renderComments: false,
				// Images inline as data: URLs — the preview CSP allows exactly
				// data:/blob: for img-src, and this keeps the document self-contained
				useBase64URL: true,
			});
			if (!container.innerHTML.trim()) {
				throw new Error("the document rendered empty — download it to read the whole file");
			}
			// The renderer emits a <style> block (page geometry, fonts) plus the
			// section markup — both are allowed by the preview CSP. Sanitized
			// like every other model-authored HTML before it reaches the panel —
			// the sandboxed iframe is the second layer, not the only one.
			sidePane.openPreview({
				kind: "html",
				title: name,
				content: DOMPurify.sanitize(container.innerHTML),
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

	const PREVIEW_TEXT_CHARS = FILE_PREVIEW_TEXT_CHARS;

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
				if (size > FILE_PREVIEW_TEXT_MAX_BYTES) {
					throw new Error("too large to preview — download it to read the whole file");
				}
				const data = await readBytes();
				// `size` is metadata recorded elsewhere, not the bytes themselves —
				// re-check what actually arrived before decoding it all, the same
				// way the pdf/docx previews re-check theirs below.
				if (data.byteLength > FILE_PREVIEW_TEXT_MAX_BYTES) {
					throw new Error("too large to preview — download it to read the whole file");
				}
				const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
				previewText =
					text.length > PREVIEW_TEXT_CHARS
						? `${text.slice(0, PREVIEW_TEXT_CHARS)}\n\n… showing the first ${(PREVIEW_TEXT_CHARS / 1000).toFixed(0)}k of ${formatFileSize(size)}`
						: text;
			} else if (previewKind === "image") {
				const data = await readBytes();
				revokePreviewUrl();
				previewUrl = URL.createObjectURL(
					new Blob([data], { type: filePreviewMimeType(extension) })
				);
			}
		} catch (err) {
			previewError =
				err instanceof Error ? err.message : "the preview is unavailable; the download still works";
		} finally {
			previewBusy = false;
		}
	}
</script>

<li class={CODE_CARD_SURFACE + " @container list-none px-2 py-1.5 text-xs"}>
	<div class="flex items-center gap-2">
		<CarbonDocument class="size-3.5 shrink-0 text-gray-400" />
		<!-- The name's own wrapper carries the min-width: a plain flex-1 with
		     min-w-0 (needed for truncate to work at all) has no floor, so a
		     row too narrow for every fixed-width sibling squeezes it to 0 and
		     the card shows a size with no name at all. min-w-[6ch] guarantees
		     enough room for a few characters before the ellipsis; the size
		     badge yields first (moves under the name) rather than take that
		     room away, once the container is too narrow for both. -->
		<span class="min-w-[6ch] flex-1">
			<span class="block truncate font-mono" title={file.path}>{name}</span>
			<span class="mt-0.5 hidden text-gray-400 @max-[304px]:block">{formatFileSize(size)}</span>
		</span>
		<span class="shrink-0 text-gray-400 @max-[304px]:hidden">{formatFileSize(size)}</span>
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
