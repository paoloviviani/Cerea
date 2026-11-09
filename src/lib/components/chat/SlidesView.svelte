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
	import CarbonChevronDown from "~icons/carbon/chevron-down";
	import ExternalLinkModal from "../ExternalLinkModal.svelte";
	import { base } from "$app/paths";
	import { PREVIEW_ALLOW, PREVIEW_SANDBOX } from "$lib/utils/previewSrcdoc";
	import { parseExternalUrl } from "$lib/utils/externalLink";
	import type { OrgSlideDefaults, OrgSlidePublic } from "$lib/utils/slides/themes";
	import { loadSlidesSrcdoc } from "$lib/utils/slides/load";

	interface Props {
		/** The deck: front matter plus reveal.js Markdown */
		content: string;
		/** The organisation's brand from the admin settings; the logo is only a flag here */
		org?: OrgSlidePublic;
		/** Fetches the organisation logo as a data: URL (cached by the caller) */
		loadOrgLogo?: () => Promise<string | undefined>;
		/** Turns a logo file name from the front matter into a data: URL */
		resolveLogo?: (name: string) => Promise<string | undefined>;
		/** Pointer events pass through while the panel is being resized */
		resizing?: boolean;
	}

	let { content, org, loadOrgLogo, resolveLogo, resizing = false }: Props = $props();

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
	let pdfFailed = $state<"failed" | "large" | "server" | null>(null);
	/** The server can make a vector PDF (the kit's fetch profile): found out on mount; null while the question is still out */
	let serverPdf = $state<boolean | null>(null);
	let serverBusy = $state(false);
	let pdfMenuOpen = $state(false);
	let pdfErrorKinds:
		| Pick<typeof import("$lib/utils/slides/slidesPdf"), "isAbortError" | "PdfTooLargeError">
		| undefined;
	let externalLinkUrl = $state<URL | null>(null);

	/** Brand with the logo loaded: the page data only says whether there is one */
	async function fullOrg(): Promise<OrgSlideDefaults | undefined> {
		if (!org) return undefined;
		const { hasLogo, ...rest } = org;
		const logo = hasLogo && loadOrgLogo ? await loadOrgLogo().catch(() => undefined) : undefined;
		return logo ? { ...rest, logo } : rest;
	}

	// Rebuild when the deck or the brand changes. The first build is immediate;
	// later ones wait for the content to hold still, so a deck that is still
	// being written (or edited) does not rebuild the frame on every change.
	const REBUILD_DEBOUNCE_MS = 400;
	let built = false;
	$effect(() => {
		const source = content;
		const brand = org;
		void brand;
		let cancelled = false;
		const build = () => {
			fullOrg()
				.then((full) => loadSlidesSrcdoc(source, channel, { org: full, resolveLogo }))
				.then((doc) => {
					if (!cancelled) {
						srcdoc = doc;
						built = true;
					}
				})
				.catch(() => {});
		};
		const timer = setTimeout(build, built ? REBUILD_DEBOUNCE_MS : 0);
		return () => {
			cancelled = true;
			clearTimeout(timer);
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
		// Leaving the panel stops a PDF export that is still running
		pdfAbort?.abort();
	});

	async function present() {
		presenting = true;
		fullscreenNative = false;
		try {
			if (iframeEl?.requestFullscreen) {
				await iframeEl.requestFullscreen();
				// Left while the browser was still deciding: the full screen arrives late, so hand it back
				if (!presenting) {
					if (document.fullscreenElement) void document.exitFullscreen();
					return;
				}
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
		if (ev.key === "Escape" && pdfMenuOpen) pdfMenuOpen = false;
		if (ev.key === "Escape" && presenting && !fullscreenNative) exitPresenting();
	}

	let pdfAbort: AbortController | undefined;

	function cancelPdf() {
		pdfAbort?.abort();
	}

	onMount(() => {
		// Whether the server can make the PDF decides what the PDF button does
		fetch(`${base}/api/v2/slides/pdf`)
			.then((r) => (r.ok ? r.json() : { available: false }))
			.then((d: { available?: boolean }) => (serverPdf = d.available === true))
			// No answer means no server PDF; the button must not stay disabled for it
			.catch(() => (serverPdf = false));
	});

	async function deckLogo(): Promise<string | undefined> {
		const { parseDeck } = await import("$lib/utils/slides/deck");
		const logo = parseDeck(content).meta.logo;
		if (!logo) return undefined;
		if (logo.startsWith("data:")) return logo;
		return resolveLogo ? await resolveLogo(logo).catch(() => undefined) : undefined;
	}

	function saveBlob(blob: Blob, name: string) {
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	}

	async function pdfFileName(): Promise<string> {
		const { parseDeck, deckTitle } = await import("$lib/utils/slides/deck");
		const title = deckTitle(parseDeck(content));
		return `${
			title
				.replace(/[^\p{L}\p{N} _-]+/gu, "")
				.trim()
				.replace(/\s+/g, "-") || "slides"
		}.pdf`;
	}

	/** The server's vector PDF, with text you can select. */
	async function downloadServerPdf() {
		if (pdfProgress || serverBusy) return;
		pdfFailed = null;
		pdfMenuOpen = false;
		const abort = new AbortController();
		pdfAbort = abort;
		serverBusy = true;
		try {
			const res = await fetch(`${base}/api/v2/slides/pdf`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ content, logo: await deckLogo() }),
				signal: abort.signal,
			});
			if (!res.ok) throw new Error(String(res.status));
			saveBlob(await res.blob(), await pdfFileName());
		} catch (err) {
			if (!(err instanceof DOMException && err.name === "AbortError")) pdfFailed = "server";
		} finally {
			serverBusy = false;
			pdfAbort = undefined;
		}
	}

	/** The deck in its own tab with reveal's print layout; the browser's print dialog saves it as a PDF. */
	async function printTab(notes = false) {
		pdfMenuOpen = false;
		const form = document.createElement("form");
		form.method = "post";
		// /api accepts a body only as JSON or multipart (hooks), so the form is multipart
		form.enctype = "multipart/form-data";
		form.action = `${base}/api/v2/slides/print?print-pdf`;
		form.target = "_blank";
		form.setAttribute("rel", "noopener");
		form.style.display = "none";
		const logo = await deckLogo();
		const fields: Record<string, string> = {
			content,
			notes: notes ? "1" : "0",
			labelPrint: m["chat.slides.print_label"](),
			labelHint: m["chat.slides.print_hint"](),
			...(logo ? { logo } : {}),
		};
		for (const [name, value] of Object.entries(fields)) {
			const input = document.createElement("input");
			input.type = "hidden";
			input.name = name;
			input.value = value;
			form.appendChild(input);
		}
		document.body.appendChild(form);
		form.submit();
		form.remove();
	}

	/** What the PDF button does on its own: the best way this deployment has. */
	function pdfDefault() {
		if (serverPdf) void downloadServerPdf();
		else void printTab(false);
	}

	async function downloadImagePdf() {
		pdfMenuOpen = false;
		if (pdfProgress) return;
		pdfFailed = null;
		const abort = new AbortController();
		pdfAbort = abort;
		pdfProgress = { done: 0, total: total || 1 };
		try {
			const { exportSlidesPdf, isAbortError, PdfTooLargeError } =
				await import("$lib/utils/slides/slidesPdf");
			pdfErrorKinds = { isAbortError, PdfTooLargeError };
			const { parseDeck, deckTitle } = await import("$lib/utils/slides/deck");
			const parsed = parseDeck(content);
			const title = deckTitle(parsed);
			const marked = await import("$lib/utils/marked").catch(() => undefined);
			let logoDataUrl: string | undefined;
			if (parsed.meta.logo && !parsed.meta.logo.startsWith("data:") && resolveLogo) {
				logoDataUrl = await resolveLogo(parsed.meta.logo).catch(() => undefined);
			}
			const blob = await exportSlidesPdf(content, {
				org: await fullOrg(),
				signal: abort.signal,
				title,
				logoDataUrl,
				highlight: marked?.highlightCode,
				onProgress: (done, count) => (pdfProgress = { done, total: count }),
			});
			saveBlob(blob, await pdfFileName());
		} catch (err) {
			if (pdfErrorKinds?.isAbortError(err)) pdfFailed = null;
			else
				pdfFailed =
					pdfErrorKinds && err instanceof pdfErrorKinds.PdfTooLargeError ? "large" : "failed";
		} finally {
			pdfProgress = null;
			pdfAbort = undefined;
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

	{#if pdfFailed}
		<p
			class="flex-none border-t border-gray-200 bg-white px-3 py-1 text-xs text-red-600 dark:border-gray-800 dark:bg-gray-900 dark:text-red-400"
			role="alert"
		>
			{pdfFailed === "large"
				? m["chat.slides.pdf_too_large"]()
				: pdfFailed === "server"
					? m["chat.slides.pdf_server_failed"]()
					: m["chat.slides.pdf_failed"]()}
		</p>
	{/if}
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
		<div class="relative flex items-center">
			<button
				type="button"
				class={btn}
				title={pdfProgress
					? m["chat.slides.pdf_busy"]({ done: pdfProgress.done, total: pdfProgress.total })
					: serverPdf
						? m["chat.slides.pdf_server"]()
						: m["chat.slides.pdf_print"]()}
				aria-label={m["chat.slides.pdf"]()}
				disabled={!!pdfProgress || serverBusy || total === 0 || serverPdf === null}
				onclick={pdfDefault}
			>
				{#if pdfProgress || serverBusy}<EosIconsLoading />{:else}<CarbonDocumentPdf />{/if}
			</button>
			<button
				type="button"
				class="{btn} -ml-1 w-5"
				title={m["chat.slides.pdf_menu"]()}
				aria-label={m["chat.slides.pdf_menu"]()}
				aria-haspopup="menu"
				aria-expanded={pdfMenuOpen}
				disabled={!!pdfProgress || serverBusy || total === 0}
				onclick={() => (pdfMenuOpen = !pdfMenuOpen)}
			>
				<CarbonChevronDown class="text-xs" />
			</button>
			{#if pdfMenuOpen}
				<div
					role="menu"
					class="absolute right-0 bottom-full z-20 mb-1 flex w-60 flex-col rounded-lg border border-gray-200 bg-white p-1 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-800"
					data-testid="slides-pdf-menu"
				>
					{#if serverPdf}
						<button
							type="button"
							role="menuitem"
							class="rounded-md px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
							onclick={downloadServerPdf}
						>
							{m["chat.slides.pdf_server"]()}
						</button>
					{/if}
					<button
						type="button"
						role="menuitem"
						class="rounded-md px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
						onclick={() => printTab(false)}
					>
						{m["chat.slides.pdf_print"]()}
					</button>
					<button
						type="button"
						role="menuitem"
						class="rounded-md px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
						onclick={() => printTab(true)}
					>
						{m["chat.slides.pdf_print_notes"]()}
					</button>
					<button
						type="button"
						role="menuitem"
						class="rounded-md px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700"
						onclick={downloadImagePdf}
					>
						{m["chat.slides.pdf_images"]()}
						<span class="block text-xs text-gray-500 dark:text-gray-400">
							{m["chat.slides.pdf_images_note"]()}
						</span>
					</button>
				</div>
			{/if}
		</div>
		{#if pdfProgress || serverBusy}
			<button
				type="button"
				class={btn}
				title={m["chat.slides.pdf_cancel"]()}
				aria-label={m["chat.slides.pdf_cancel"]()}
				onclick={cancelPdf}
			>
				<CarbonClose />
			</button>
		{/if}
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
