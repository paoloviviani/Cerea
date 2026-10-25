<script lang="ts">
	import { onDestroy, onMount } from "svelte";
	import { dataUrlBytes, openPdf, type PdfDocument } from "$lib/utils/pdfRender";
	import { triggerBrowserDownload } from "$lib/utils/fileBytes";
	import CarbonDownload from "~icons/carbon/download";
	import CarbonLaunch from "~icons/carbon/launch";

	/**
	 * A PDF drawn in the page with pdf.js, the same on a desktop and a phone:
	 * one canvas per page at the pane's width. The browser's own viewer is
	 * not involved (a phone draws no PDF in a frame), so there is no "opens in
	 * a new tab" dead end; a new-tab and a download button stay as secondary
	 * actions. pdf.js is loaded the first time a PDF is opened.
	 */
	interface Props {
		title: string;
		bytes?: Uint8Array;
		/** The same PDF as a `data:` URL, for callers that carry it that way. */
		dataUrl?: string;
	}

	let { title, bytes, dataUrl }: Props = $props();

	/** Pages drawn; the download has the rest. */
	const MAX_PAGES = 60;

	let host: HTMLDivElement | undefined = $state();
	let status = $state<"loading" | "ready" | "error">("loading");
	let failure = $state<string | null>(null);
	let pageCount = $state(0);
	let shown = $state(0);
	let doc: PdfDocument | undefined;
	let destroyDoc: (() => Promise<void>) | undefined;
	let destroyed = false;
	let renderToken = 0;

	function source(): Uint8Array {
		if (bytes) return bytes;
		if (dataUrl) return dataUrlBytes(dataUrl);
		throw new Error("there is nothing to show");
	}

	async function draw(): Promise<void> {
		if (!doc || !host) return;
		const token = ++renderToken;
		const width = Math.max(host.clientWidth - 24, 200);
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		host.replaceChildren();
		shown = Math.min(doc.numPages, MAX_PAGES);
		for (let n = 1; n <= shown; n++) {
			const page = await doc.getPage(n);
			if (destroyed || token !== renderToken) return;
			const base = page.getViewport({ scale: 1 });
			const viewport = page.getViewport({ scale: (width / base.width) * dpr });
			const canvas = document.createElement("canvas");
			canvas.width = Math.floor(viewport.width);
			canvas.height = Math.floor(viewport.height);
			canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
			canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
			canvas.className = "mx-auto mb-3 max-w-full bg-white shadow-sm";
			canvas.setAttribute("role", "img");
			canvas.setAttribute("aria-label", `${title}, page ${n} of ${doc.numPages}`);
			canvas.dataset.testid = "pdf-page";
			host.appendChild(canvas);
			await page.render({ canvas, viewport }).promise;
		}
	}

	// Draw once both the document and the host element exist. The element is
	// bound after the status flips and the DOM updates, so drawing straight
	// after opening raced it and, when it lost, drew nothing at all.
	let drawn = false;
	$effect(() => {
		if (status === "ready" && host && !drawn) {
			drawn = true;
			void draw().catch((err) => {
				status = "error";
				failure = `this PDF could not be shown (${err instanceof Error ? err.message : "render failed"}); download it to read it`;
			});
		}
	});

	onMount(() => {
		void (async () => {
			try {
				const opened = await openPdf(source());
				doc = opened.doc;
				destroyDoc = opened.destroy;
				if (destroyed) {
					void destroyDoc();
					return;
				}
				pageCount = doc.numPages;
				status = "ready";
			} catch (err) {
				if (destroyed) return;
				status = "error";
				failure =
					err instanceof Error
						? `this PDF could not be shown (${err.message}); download it to read it`
						: "this PDF could not be shown; download it to read it";
			}
		})();
		// Redraw when the pane is resized to a clearly different width.
		let last = 0;
		const observer = new ResizeObserver(() => {
			const w = host?.clientWidth ?? 0;
			if (doc && last && Math.abs(w - last) > 40) void draw();
			last = w;
		});
		if (host) observer.observe(host);
		return () => observer.disconnect();
	});

	onDestroy(() => {
		destroyed = true;
		void destroyDoc?.();
	});

	function openInNewTab(): void {
		try {
			const blob = new Blob([source() as Uint8Array<ArrayBuffer>], { type: "application/pdf" });
			window.open(URL.createObjectURL(blob), "_blank", "noopener,noreferrer");
		} catch {
			// The pane stays useful as it is.
		}
	}

	function download(): void {
		try {
			const data = source();
			triggerBrowserDownload(
				title.toLowerCase().endsWith(".pdf") ? title : `${title}.pdf`,
				data.slice() as Uint8Array<ArrayBuffer>
			);
		} catch {
			// Nothing to download.
		}
	}
</script>

<div class="flex h-full min-h-0 flex-col bg-gray-50 dark:bg-gray-900" data-testid="pdf-viewer">
	<div
		class="flex flex-none items-center gap-2 border-b border-gray-200/70 px-3 py-1.5 text-xs text-gray-500 dark:border-gray-700/70 dark:text-gray-400"
	>
		<span class="min-w-0 flex-1 truncate">
			{#if status === "loading"}Loading the PDF…{:else if status === "ready"}{pageCount} page{pageCount ===
				1
					? ""
					: "s"}{pageCount > shown ? ` (first ${shown} shown)` : ""}{/if}
		</span>
		<button
			type="button"
			class="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-gray-500/10"
			onclick={openInNewTab}
			aria-label="Open {title} in a new tab"
			title="Open in a new tab"
		>
			<CarbonLaunch class="size-3.5" />
			<span>New tab</span>
		</button>
		<button
			type="button"
			class="flex items-center gap-1 rounded-md px-2 py-1 hover:bg-gray-500/10"
			onclick={download}
			aria-label="Download {title}"
			title="Download"
		>
			<CarbonDownload class="size-3.5" />
		</button>
	</div>
	{#if status === "error"}
		<div class="flex flex-1 items-center justify-center px-6 py-8">
			<p class="max-w-sm text-center text-sm text-amber-600 dark:text-amber-400">{failure}</p>
		</div>
	{:else}
		<div bind:this={host} class="scrollbar-custom min-h-0 flex-1 overflow-y-auto p-3"></div>
	{/if}
</div>
