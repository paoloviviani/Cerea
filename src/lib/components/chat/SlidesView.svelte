<script lang="ts">
	import { m } from "$lib/paraglide/messages";
	import { onDestroy, onMount } from "svelte";
	import CarbonChevronLeft from "~icons/carbon/chevron-left";
	import CarbonChevronRight from "~icons/carbon/chevron-right";
	import CarbonDocumentPdf from "~icons/carbon/document-pdf";
	import CarbonMaximize from "~icons/carbon/maximize";
	import CarbonClose from "~icons/carbon/close";
	import LucideStickyNote from "~icons/lucide/sticky-note";
	import EosIconsLoading from "~icons/eos-icons/loading";
	import ExternalLinkModal from "../ExternalLinkModal.svelte";
	import { PREVIEW_ALLOW, PREVIEW_SANDBOX } from "$lib/utils/previewSrcdoc";
	import { parseExternalUrl } from "$lib/utils/externalLink";
	import type { OrgSlideDefaults } from "$lib/utils/slides/themes";
	import { loadSlidesSrcdoc } from "$lib/utils/slides/load";

	interface Props {
		/** The deck: front matter plus reveal.js Markdown */
		content: string;
		/** Organisation default look from the admin settings */
		org?: OrgSlideDefaults;
		/** Turns a logo file name from the front matter into a data: URL */
		resolveLogo?: (name: string) => Promise<string | undefined>;
		/** Pointer events pass through while the panel is being resized */
		resizing?: boolean;
	}

	let { content, org, resolveLogo, resizing = false }: Props = $props();

	const channel = `slides_${Math.random().toString(36).slice(2)}`;
	let iframeEl: HTMLIFrameElement | undefined = $state();
	let srcdoc = $state<string | undefined>();
	let index = $state(0);
	let total = $state(0);
	let hasNotes = $state(false);
	let notesOpen = $state(false);
	let presenting = $state(false);
	/** True when the browser took the iframe full screen; false means the in-page overlay */
	let fullscreenNative = $state(false);
	let pdfProgress = $state<{ done: number; total: number } | null>(null);
	let pdfFailed = $state(false);
	let externalLinkUrl = $state<URL | null>(null);

	// Rebuild whenever the deck, the organisation default or the logo changes
	$effect(() => {
		const source = content;
		const defaults = org;
		let cancelled = false;
		loadSlidesSrcdoc(source, channel, { org: defaults, resolveLogo })
			.then((doc) => {
				if (!cancelled) srcdoc = doc;
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	});

	function send(cmd: string) {
		iframeEl?.contentWindow?.postMessage(
			{ type: "chatui.slides.cmd", channel, detail: { cmd } },
			"*"
		);
	}

	function onMessage(ev: MessageEvent) {
		if (!iframeEl || ev.source !== iframeEl.contentWindow) return;
		const data = ev.data as {
			type?: unknown;
			channel?: unknown;
			detail?: Record<string, unknown>;
		} | null;
		if (!data || data.channel !== channel) return;
		if (data.type === "chatui.slides.state") {
			const d = data.detail ?? {};
			index = Number(d.index) || 0;
			total = Number(d.total) || 0;
			hasNotes = d.notes === true;
			notesOpen = d.notesOpen === true;
		} else if (data.type === "chatui.preview.openLink") {
			// Same rule as every preview: only a real user gesture opens the confirm
			if (navigator.userActivation && !navigator.userActivation.isActive) return;
			externalLinkUrl = parseExternalUrl(data.detail?.href) ?? null;
		}
	}

	onMount(() => {
		window.addEventListener("message", onMessage);
		const onFullscreen = () => {
			if (!document.fullscreenElement && presenting && fullscreenNative) presenting = false;
		};
		document.addEventListener("fullscreenchange", onFullscreen);
		return () => document.removeEventListener("fullscreenchange", onFullscreen);
	});
	onDestroy(() => {
		if (typeof window !== "undefined") window.removeEventListener("message", onMessage);
	});

	async function present() {
		presenting = true;
		fullscreenNative = false;
		try {
			if (iframeEl?.requestFullscreen) {
				await iframeEl.requestFullscreen();
				fullscreenNative = true;
			}
		} catch {
			// Fall back to the in-page overlay below
		}
		iframeEl?.focus();
	}

	function exitPresenting() {
		if (document.fullscreenElement) void document.exitFullscreen();
		presenting = false;
	}

	function onWindowKeydown(ev: KeyboardEvent) {
		if (ev.key === "Escape" && presenting && !fullscreenNative) exitPresenting();
	}

	async function downloadPdf() {
		if (pdfProgress) return;
		pdfFailed = false;
		pdfProgress = { done: 0, total: total || 1 };
		try {
			const { exportSlidesPdf } = await import("$lib/utils/slides/slidesPdf");
			const { parseDeck, deckTitle } = await import("$lib/utils/slides/deck");
			const parsed = parseDeck(content);
			const title = deckTitle(parsed);
			const marked = await import("$lib/utils/marked").catch(() => undefined);
			let logoDataUrl: string | undefined;
			if (parsed.meta.logo && !parsed.meta.logo.startsWith("data:") && resolveLogo) {
				logoDataUrl = await resolveLogo(parsed.meta.logo).catch(() => undefined);
			}
			const blob = await exportSlidesPdf(content, {
				org,
				title,
				logoDataUrl,
				highlight: marked?.highlightCode,
				onProgress: (done, count) => (pdfProgress = { done, total: count }),
			});
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${
				title
					.replace(/[^\p{L}\p{N} _-]+/gu, "")
					.trim()
					.replace(/\s+/g, "-") || "slides"
			}.pdf`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch {
			pdfFailed = true;
		} finally {
			pdfProgress = null;
		}
	}

	const btn =
		"btn flex size-8 items-center justify-center rounded-md text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-40 dark:text-gray-300 dark:hover:bg-gray-800";
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="flex h-full min-h-0 flex-col" data-testid="slides-view">
	<div class="relative min-h-0 flex-1 bg-white dark:bg-gray-900">
		{#if srcdoc}
			<iframe
				bind:this={iframeEl}
				title={m["chat.slides.label"]()}
				class={presenting && !fullscreenNative
					? "fixed inset-0 z-50 h-full w-full bg-black"
					: `h-full w-full bg-white dark:bg-gray-900 ${resizing ? "pointer-events-none" : ""}`}
				sandbox={PREVIEW_SANDBOX}
				allow={PREVIEW_ALLOW}
				allowfullscreen
				referrerpolicy="no-referrer"
				{srcdoc}
			></iframe>
			{#if presenting && !fullscreenNative}
				<button
					type="button"
					class="fixed top-3 right-3 z-50 flex size-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80"
					title={m["chat.slides.exit"]()}
					aria-label={m["chat.slides.exit"]()}
					onclick={exitPresenting}
				>
					<CarbonClose />
				</button>
			{/if}
		{/if}
	</div>

	<div
		class="flex flex-none items-center gap-1 border-t border-gray-200 bg-white px-2 py-1 dark:border-gray-800 dark:bg-gray-900"
		data-testid="slides-bar"
	>
		<button
			type="button"
			class={btn}
			title={m["chat.slides.prev"]()}
			aria-label={m["chat.slides.prev"]()}
			disabled={total === 0}
			onclick={() => send("prev")}
		>
			<CarbonChevronLeft />
		</button>
		<span
			class="min-w-14 text-center font-mono text-xs text-gray-600 tabular-nums dark:text-gray-300"
			aria-live="polite"
			data-testid="slides-counter"
		>
			{m["chat.slides.counter"]({ current: total ? index + 1 : 0, total })}
		</span>
		<button
			type="button"
			class={btn}
			title={m["chat.slides.next"]()}
			aria-label={m["chat.slides.next"]()}
			disabled={total === 0}
			onclick={() => send("next")}
		>
			<CarbonChevronRight />
		</button>
		<span class="flex-1"></span>
		{#if pdfFailed}
			<span class="hidden truncate text-xs text-red-600 sm:inline dark:text-red-400" role="alert">
				{m["chat.slides.pdf_failed"]()}
			</span>
		{/if}
		<button
			type="button"
			class="{btn} {notesOpen ? 'bg-gray-100 dark:bg-gray-800' : ''}"
			title={m["chat.slides.notes"]()}
			aria-label={m["chat.slides.notes"]()}
			aria-pressed={notesOpen}
			disabled={!hasNotes && !notesOpen}
			onclick={() => send("notes")}
		>
			<LucideStickyNote />
		</button>
		<button
			type="button"
			class={btn}
			title={pdfProgress
				? m["chat.slides.pdf_busy"]({ done: pdfProgress.done, total: pdfProgress.total })
				: m["chat.slides.pdf"]()}
			aria-label={m["chat.slides.pdf"]()}
			disabled={!!pdfProgress || total === 0}
			onclick={downloadPdf}
		>
			{#if pdfProgress}<EosIconsLoading />{:else}<CarbonDocumentPdf />{/if}
		</button>
		<button
			type="button"
			class={btn}
			title={m["chat.slides.present"]()}
			aria-label={m["chat.slides.present"]()}
			disabled={total === 0}
			onclick={present}
		>
			<CarbonMaximize />
		</button>
	</div>
</div>

{#if externalLinkUrl}
	<ExternalLinkModal url={externalLinkUrl} onclose={() => (externalLinkUrl = null)} />
{/if}
