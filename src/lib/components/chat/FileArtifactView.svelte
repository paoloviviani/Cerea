<script lang="ts">
	import { onDestroy } from "svelte";
	import { base } from "$app/paths";
	import { page } from "$app/state";
	import SlideImages from "./SlideImages.svelte";
	import PdfViewer from "./PdfViewer.svelte";
	import {
		fetchPreviewPdfBytes,
		officePreviewEnabledIn,
		previewUrlFor,
		slidesPayloadFor,
	} from "$lib/utils/officePreview";
	import CarbonDocument from "~icons/carbon/document";
	import CarbonDownload from "~icons/carbon/download";
	import { renderDocxPreview } from "$lib/utils/docxPreview";
	import type { FileArtifactVersion } from "$lib/utils/fileArtifacts";
	import { readFileBytes, triggerBrowserDownload } from "$lib/utils/fileBytes";
	import { cachedFileBytes, fileBaseName } from "$lib/utils/execution/fileIdentity";
	import {
		FILE_PREVIEW_MAX_BYTES,
		FILE_PREVIEW_TEXT_CHARS,
		FILE_PREVIEW_TEXT_MAX_BYTES,
		fileExtensionOf,
		filePreviewMimeType,
		formatFileSize,
		previewPlan,
		type FilePreviewKind,
	} from "$lib/utils/filePreview";
	import { buildDocxSrcdoc, PREVIEW_ALLOW, PREVIEW_SANDBOX } from "$lib/utils/previewSrcdoc";
	import { escapeHTML } from "$lib/utils/markedLight";

	/**
	 * One version of a file artifact in the artifact panel. The bytes come from
	 * this tab's own copy while it holds them, else from the server-side output
	 * store (GridFS, addressed by conversation + sha256, never duplicated).
	 * What renders is `previewPlan`'s answer, the same on every device: PDFs in
	 * the page by pdf.js, decks by pptx-glimpse (or the server's PDF when it
	 * has one), Word files by docx-preview + DOMPurify in a sandboxed frame, a
	 * download card for everything else.
	 */
	interface Props {
		version: FileArtifactVersion;
		conversationId: string | undefined;
	}

	let { version, conversationId }: Props = $props();

	const stored = $derived(version.uploaded !== false);
	const downloadUrl = $derived(
		conversationId && stored
			? `${base}/conversation/${conversationId}/code-execution/output/${version.sha256}`
			: undefined
	);
	// This tab's own bytes make a file available even before (or without) the store.
	const available = $derived(
		downloadUrl !== undefined || cachedFileBytes(version.sha256) !== undefined
	);
	const converter = $derived(officePreviewEnabledIn(page.data));
	const plan = $derived(
		previewPlan(version.name, { converter, stored: downloadUrl !== undefined })
	);
	const kind = $derived(plan.kind);
	const baseName = $derived(fileBaseName(version.name));

	type Payload =
		| { kind: "text"; text: string; truncated: boolean }
		| { kind: "image"; url: string }
		| { kind: "pdf"; bytes: Uint8Array }
		| { kind: "docx"; html: string }
		| {
				kind: "slides";
				slides: { number: number; src: string }[];
				note: string | null;
				details: string[];
		  };

	let status = $state<"idle" | "loading" | "ready" | "error">("idle");
	let payload = $state<Payload | null>(null);
	let error = $state<string | null>(null);
	// Plain, not $state: the template shows `payload.url`, and the effect
	// below reads this through revokeObjectUrl(). As state it became the
	// effect's dependency, so setting it after a fetch restarted the effect:
	// every image re-downloaded forever and never left "Loading preview…".
	let objectUrl: string | null = null;

	function revokeObjectUrl() {
		if (objectUrl) {
			URL.revokeObjectURL(objectUrl);
			objectUrl = null;
		}
	}

	onDestroy(revokeObjectUrl);

	const TOO_BIG = "too large to preview — download it to read the whole document";

	// Refetch whenever the version (or its conversation) changes; a slow
	// earlier fetch that resolves after a version switch is dropped.
	$effect(() => {
		const url = downloadUrl;
		const name = version.name;
		const size = version.size;
		const sha = version.sha256;
		const { kind: selected, fallback } = plan;
		const ext = fileExtensionOf(name);
		const here = available;
		if (!here || selected === "none") {
			status = "idle";
			payload = null;
			error = null;
			revokeObjectUrl();
			return;
		}
		if (
			size > FILE_PREVIEW_MAX_BYTES &&
			(selected === "pdf" || selected === "docx" || selected === "pptx" || selected === "office")
		) {
			status = "error";
			payload = null;
			error = TOO_BIG;
			revokeObjectUrl();
			return;
		}
		if (selected === "text" && size > FILE_PREVIEW_TEXT_MAX_BYTES) {
			status = "error";
			payload = null;
			error = "too large to preview — download it to read the whole file";
			revokeObjectUrl();
			return;
		}
		let cancelled = false;
		status = "loading";
		payload = null;
		error = null;
		revokeObjectUrl();

		const bytesOf = async () => {
			const data = await readFileBytes({
				file: { path: name, size },
				sha256: sha,
				downloadUrl: url,
			});
			return data instanceof Uint8Array ? data : new Uint8Array(data);
		};

		async function render(kindToRender: FilePreviewKind): Promise<Payload> {
			if (kindToRender === "office") {
				// The server's PDF of this file (made on the first view and
				// kept), drawn by pdf.js like any PDF.
				return { kind: "pdf", bytes: await fetchPreviewPdfBytes(previewUrlFor(url ?? "")) };
			}
			const bytes = await bytesOf();
			if (kindToRender === "pptx") {
				if (bytes.byteLength > FILE_PREVIEW_MAX_BYTES) throw new Error(TOO_BIG);
				const shown = await slidesPayloadFor(name, bytes);
				return {
					kind: "slides",
					slides: shown.slides ?? [],
					note: shown.note ?? null,
					details: shown.details ?? [],
				};
			}
			if (kindToRender === "text") {
				// The recorded size is metadata, not the bytes themselves.
				if (bytes.byteLength > FILE_PREVIEW_TEXT_MAX_BYTES) {
					throw new Error("too large to preview — download it to read the whole file");
				}
				const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
				return text.length > FILE_PREVIEW_TEXT_CHARS
					? { kind: "text", text: text.slice(0, FILE_PREVIEW_TEXT_CHARS), truncated: true }
					: { kind: "text", text, truncated: false };
			}
			if (kindToRender === "image") {
				objectUrl = URL.createObjectURL(
					new Blob([bytes as Uint8Array<ArrayBuffer>], { type: filePreviewMimeType(ext) })
				);
				return { kind: "image", url: objectUrl };
			}
			if (kindToRender === "pdf") {
				if (bytes.byteLength > FILE_PREVIEW_MAX_BYTES) throw new Error(TOO_BIG);
				return { kind: "pdf", bytes };
			}
			if (bytes.byteLength > FILE_PREVIEW_MAX_BYTES) throw new Error(TOO_BIG);
			const html = await renderDocxPreview(bytes, { fontBase: `${base}/fonts/office` });
			return { kind: "docx", html };
		}

		void (async () => {
			try {
				let shown: Payload;
				try {
					shown = await render(selected);
				} catch (err) {
					// The server's conversion failed or is not there: draw it from the bytes.
					if (!fallback || cancelled) throw err;
					shown = await render(fallback);
				}
				if (cancelled) {
					revokeObjectUrl();
					return;
				}
				payload = shown;
				status = "ready";
			} catch (err) {
				if (cancelled) return;
				status = "error";
				payload = null;
				error =
					err instanceof Error
						? err.message
						: "the preview is unavailable; the download still works";
			}
		})();
		return () => {
			cancelled = true;
		};
	});

	async function downloadNone(): Promise<void> {
		try {
			triggerBrowserDownload(
				baseName,
				await readFileBytes({
					file: { path: version.name, size: version.size },
					sha256: version.sha256,
					downloadUrl,
				})
			);
		} catch {
			// The card stays as it is.
		}
	}

	const docxChannel = `file_${Math.random().toString(36).slice(2)}`;
	let docxSrcdoc = $derived(
		payload?.kind === "docx" ? buildDocxSrcdoc(payload.html, docxChannel) : ""
	);
</script>

<div class="flex h-full flex-col" data-testid="file-artifact-view" data-kind={kind}>
	{#if !available}
		<div class="flex flex-1 items-center justify-center px-6 py-8">
			<p class="max-w-sm text-center text-sm text-gray-400">
				{stored
					? "This file is no longer available."
					: "This file was not saved and is no longer available. Run the code again to make it again."}
			</p>
		</div>
	{:else if kind === "none"}
		<div class="flex flex-1 items-center justify-center px-6 py-8">
			<div
				class="flex w-full max-w-sm items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800/80"
			>
				<CarbonDocument class="size-8 flex-none text-gray-400" />
				<div class="min-w-0 flex-1">
					<p
						class="truncate font-mono text-sm text-gray-800 dark:text-gray-200"
						title={version.name}
					>
						{version.name}
					</p>
					<p class="text-xs text-gray-500 dark:text-gray-400">{formatFileSize(version.size)}</p>
				</div>
				<button
					type="button"
					onclick={downloadNone}
					class="flex flex-none items-center gap-1 rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10"
					aria-label={`Download ${baseName}`}
				>
					<CarbonDownload class="size-3.5" /> Download
				</button>
			</div>
		</div>
	{:else if status === "loading" || status === "idle"}
		<div class="flex flex-1 items-center justify-center px-6 py-8">
			<p class="text-sm text-gray-400">Loading preview…</p>
		</div>
	{:else if status === "error"}
		<div class="flex flex-1 items-center justify-center px-6 py-8">
			<p class="max-w-sm text-center text-sm text-amber-600 dark:text-amber-400">{error}</p>
		</div>
	{:else if payload?.kind === "text"}
		<div class="scrollbar-custom min-h-0 flex-1 overflow-y-auto px-6 py-5">
			<!-- eslint-disable svelte/no-at-html-tags -->
			<pre
				class="overflow-auto rounded-lg border border-gray-200/70 bg-gray-50 p-3 font-mono text-xs break-words whitespace-pre-wrap text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">{@html escapeHTML(
					payload.text
				)}</pre>
			{#if payload.truncated}
				<p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
					Showing the first {(FILE_PREVIEW_TEXT_CHARS / 1000).toFixed(0)}k of {formatFileSize(
						version.size
					)} — download for the rest.
				</p>
			{/if}
		</div>
	{:else if payload?.kind === "image"}
		<div
			class="scrollbar-custom flex min-h-0 flex-1 items-start justify-center overflow-auto px-6 py-5"
		>
			<img
				src={payload.url}
				alt={`Preview of ${version.name}`}
				class="max-h-full rounded-lg border border-gray-200/70 dark:border-gray-700"
			/>
		</div>
	{:else if payload?.kind === "pdf"}
		<div class="relative min-h-0 flex-1">
			<PdfViewer title={baseName} bytes={payload.bytes} />
		</div>
	{:else if payload?.kind === "slides"}
		<div class="min-h-0 flex-1">
			<SlideImages
				title={version.name}
				slides={payload.slides}
				note={payload.note}
				details={payload.details}
			/>
		</div>
	{:else if payload?.kind === "docx"}
		<div class="min-h-0 flex-1">
			<iframe
				title={`Preview of ${version.name}`}
				class="h-full w-full bg-white dark:bg-gray-900"
				sandbox={PREVIEW_SANDBOX}
				allow={PREVIEW_ALLOW}
				allowfullscreen
				referrerpolicy="no-referrer"
				srcdoc={docxSrcdoc}
			></iframe>
		</div>
	{/if}
</div>
