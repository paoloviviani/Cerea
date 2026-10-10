<script lang="ts">
	import { onDestroy } from "svelte";
	import { base } from "$app/paths";
	import CarbonDocument from "~icons/carbon/document";
	import CarbonDownload from "~icons/carbon/download";
	import { renderDocxPreview } from "$lib/utils/docxPreview";
	import type { FileArtifactVersion } from "$lib/utils/fileArtifacts";
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
		browserRendersPdfInFrame,
		buildDocxSrcdoc,
		PREVIEW_ALLOW,
		PREVIEW_SANDBOX,
	} from "$lib/utils/previewSrcdoc";
	import { escapeHTML } from "$lib/utils/markedLight";

	/**
	 * One version of a file artifact in the artifact panel: the persisted
	 * bytes fetched from the server-side output store (GridFS, addressed by
	 * conversation + sha256 — never duplicated), rendered through the shared
	 * `$lib/utils/filePreview` selection with FileCard's exact posture:
	 * typed application/pdf in an UNSANDBOXED frame (the native viewer
	 * refuses sandboxed frames), docx-preview offscreen + DOMPurify, and a
	 * download card for everything else.
	 */
	interface Props {
		version: FileArtifactVersion;
		conversationId: string | undefined;
	}

	let { version, conversationId }: Props = $props();

	const downloadUrl = $derived(
		conversationId
			? `${base}/conversation/${conversationId}/code-execution/output/${version.sha256}`
			: undefined
	);
	const kind = $derived(filePreviewKindFor(version.name));

	type Payload =
		| { kind: "text"; text: string; truncated: boolean }
		| { kind: "image"; url: string }
		| { kind: "pdf"; dataUrl: string }
		| { kind: "docx"; html: string };

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

	function dataUrlOf(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = () =>
				reject(reader.error ?? new Error("the preview is unavailable; the download still works"));
			reader.readAsDataURL(blob);
		});
	}

	// Refetch whenever the version (or its conversation) changes; a slow
	// earlier fetch that resolves after a version switch is dropped.
	$effect(() => {
		const url = downloadUrl;
		const name = version.name;
		const size = version.size;
		const selected = filePreviewKindFor(name);
		const ext = fileExtensionOf(name);
		if (!url || selected === "none") {
			status = "idle";
			payload = null;
			error = null;
			revokeObjectUrl();
			return;
		}
		if (size > FILE_PREVIEW_MAX_BYTES && (selected === "pdf" || selected === "docx")) {
			status = "error";
			payload = null;
			error = "too large to preview — download it to read the whole document";
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
		void (async () => {
			try {
				const res = await fetch(url);
				if (!res.ok) throw new Error("that file is no longer available");
				if (selected === "text") {
					const blob = await res.blob();
					if (cancelled) return;
					// The recorded size is metadata from the message, not the bytes
					// themselves — re-check what actually arrived before decoding it all.
					if (blob.size > FILE_PREVIEW_TEXT_MAX_BYTES) {
						throw new Error("too large to preview — download it to read the whole file");
					}
					const text = await blob.text();
					if (cancelled) return;
					payload =
						text.length > FILE_PREVIEW_TEXT_CHARS
							? {
									kind: "text",
									text: text.slice(0, FILE_PREVIEW_TEXT_CHARS),
									truncated: true,
								}
							: { kind: "text", text, truncated: false };
				} else if (selected === "image") {
					const blob = await res.blob();
					if (cancelled) return;
					revokeObjectUrl();
					objectUrl = URL.createObjectURL(new Blob([blob], { type: filePreviewMimeType(ext) }));
					payload = { kind: "image", url: objectUrl };
				} else if (selected === "pdf") {
					const blob = await res.blob();
					if (cancelled) return;
					// The recorded size is metadata from the message, not the bytes
					// themselves — re-check what actually arrived before building the
					// data: URL (base64 inflates a third on top of it).
					if (blob.size > FILE_PREVIEW_MAX_BYTES) {
						throw new Error("too large to preview — download it to read the whole document");
					}
					// Typed application/pdf by this app: a typeless blob framed
					// here downloads instead of rendering.
					const dataUrl = await dataUrlOf(new Blob([blob], { type: "application/pdf" }));
					if (cancelled) return;
					payload = { kind: "pdf", dataUrl };
				} else {
					const buffer = await res.arrayBuffer();
					if (cancelled) return;
					// The recorded size is metadata from the message, not the bytes
					// themselves — re-check what actually arrived before handing it to
					// docx-preview.
					if (buffer.byteLength > FILE_PREVIEW_MAX_BYTES) {
						throw new Error("too large to preview — download it to read the whole document");
					}
					const html = await renderDocxPreview(new Uint8Array(buffer));
					if (cancelled) return;
					payload = { kind: "docx", html };
				}
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

	const docxChannel = `file_${Math.random().toString(36).slice(2)}`;
	let docxSrcdoc = $derived(
		payload?.kind === "docx" ? buildDocxSrcdoc(payload.html, docxChannel) : ""
	);

	// Mobile engines draw no PDF in an iframe even unsandboxed (see
	// browserRendersPdfInFrame): the pop-out opens the bytes in the
	// browser's own viewer, like PreviewPane's.
	async function openPdfInNewTab(dataUrl: string): Promise<void> {
		try {
			const res = await fetch(dataUrl);
			const blob = await res.blob();
			window.open(URL.createObjectURL(blob), "_blank", "noopener,noreferrer");
		} catch {
			// The panel stays useful as-is; the close button is the exit.
		}
	}
</script>

<div class="flex h-full flex-col" data-testid="file-artifact-view" data-kind={kind}>
	{#if !downloadUrl}
		<div class="flex flex-1 items-center justify-center px-6 py-8">
			<p class="text-sm text-gray-400">This file is no longer available.</p>
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
				<a
					href={downloadUrl}
					download={version.name}
					class="flex flex-none items-center gap-1 rounded-md px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10"
					aria-label={`Download ${version.name}`}
				>
					<CarbonDownload class="size-3.5" /> Download
				</a>
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
			{#if browserRendersPdfInFrame()}
				<!-- No sandbox token set, deliberately: the native viewer
				     refuses sandboxed opaque-origin frames. Bytes typed
				     application/pdf by this app; no document script executes. -->
				<iframe
					title={`Preview of ${version.name}`}
					class="h-full w-full bg-white dark:bg-gray-900"
					allow={PREVIEW_ALLOW}
					allowfullscreen
					referrerpolicy="no-referrer"
					src={payload.dataUrl}
				></iframe>
			{:else}
				<div
					class="flex h-full flex-col items-center justify-center gap-3 bg-gray-50 px-6 text-center dark:bg-gray-900"
				>
					<CarbonDocument class="size-10 text-gray-400" />
					<p class="text-sm text-gray-600 dark:text-gray-300">
						{version.name} opens in the browser's PDF viewer
					</p>
					<button
						class="btn rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
						onclick={() => payload?.kind === "pdf" && openPdfInNewTab(payload.dataUrl)}
					>
						Open in a new tab
					</button>
				</div>
			{/if}
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
