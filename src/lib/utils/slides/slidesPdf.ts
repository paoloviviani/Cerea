/**
 * "Download PDF" for a slides artifact (ADR 0111).
 *
 * The deck renders in a second, offscreen copy of the preview sandbox at its
 * design size (1280x720, no transitions or fragments). The app asks it for
 * one slide at a time; the sandbox draws the slide with SnapDOM (the library
 * the screenshot button already ships) and answers with a JPEG data URL; the
 * pages are written into a PDF here. Nothing leaves the browser, it needs no
 * server component (Gotenberg is optional and runs Chromium with JavaScript
 * off, so it cannot render reveal.js), and the sandbox stays closed: no
 * popups or print dialog (`allow-modals`) for generated code.
 */
import { PREVIEW_ALLOW, PREVIEW_SANDBOX } from "../previewSrcdoc";
import { loadCaptureLibrarySource } from "../artifactCapture";
import { buildPdf, dataUrlToBytes, jpegSize, type PdfPage } from "./pdf";
import { buildSlidesSrcdocFrom, type SlidesSrcdocOptions } from "./srcdoc";
import { parseDeck } from "./deck";

const SLIDE_WIDTH = 1280;
const SLIDE_HEIGHT = 720;
const READY_TIMEOUT_MS = 20_000;
const SLIDE_TIMEOUT_MS = 15_000;
const MAX_SLIDES = 200;
/** Total size of the page pictures kept in memory before the PDF is written. */
export const MAX_PDF_BYTES = 150 * 1024 * 1024;
const MAX_JPEG_DATA_URL = 8_000_000;
const JPEG_PREFIX = "data:image/jpeg;base64,";

export interface SlidesPdfOptions extends Omit<SlidesSrcdocOptions, "pdf"> {
	title?: string;
	onProgress?: (done: number, total: number) => void;
	/** Aborting stops the export and removes the offscreen frame; the promise rejects with an AbortError. */
	signal?: AbortSignal;
	/** Cap on the page pictures held at once (default 150 MB); beyond it the export fails with PdfTooLargeError. */
	maxBytes?: number;
}

/** The deck needs more memory than a PDF export may use (too many slides, or very heavy ones). */
export class PdfTooLargeError extends Error {
	constructor(message = "This deck is too large to export as a PDF") {
		super(message);
		this.name = "PdfTooLargeError";
	}
}

function abortError(): Error {
	const e = new Error("The PDF export was cancelled");
	e.name = "AbortError";
	return e;
}

export function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

export async function exportSlidesPdf(content: string, opts: SlidesPdfOptions = {}): Promise<Blob> {
	const { signal } = opts;
	const maxBytes = opts.maxBytes ?? MAX_PDF_BYTES;
	if (signal?.aborted) throw abortError();
	const source = await loadCaptureLibrarySource();
	if (signal?.aborted) throw abortError();
	const channel = `slidespdf_${Math.random().toString(36).slice(2)}`;
	const parsed = parseDeck(content);
	const iframe = document.createElement("iframe");
	iframe.setAttribute("sandbox", PREVIEW_SANDBOX);
	iframe.setAttribute("allow", PREVIEW_ALLOW);
	iframe.setAttribute("referrerpolicy", "no-referrer");
	iframe.setAttribute("aria-hidden", "true");
	iframe.tabIndex = -1;
	iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;border:0;visibility:hidden;pointer-events:none`;

	type Waiter = {
		match: (type: string, detail: Record<string, unknown>) => boolean;
		resolve: (d: Record<string, unknown>) => void;
	};
	let waiter: Waiter | undefined;
	const onMessage = (ev: MessageEvent) => {
		if (ev.source !== iframe.contentWindow) return;
		const data = ev.data as { type?: unknown; channel?: unknown; detail?: unknown } | null;
		if (!data || data.channel !== channel || typeof data.type !== "string") return;
		const detail = (data.detail && typeof data.detail === "object" ? data.detail : {}) as Record<
			string,
			unknown
		>;
		if (waiter?.match(data.type, detail)) {
			const w = waiter;
			waiter = undefined;
			w.resolve(detail);
		}
	};
	const waitFor = (match: Waiter["match"], ms: number, what: string) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const onAbort = () => {
				clearTimeout(timer);
				waiter = undefined;
				reject(abortError());
			};
			const timer = setTimeout(() => {
				waiter = undefined;
				signal?.removeEventListener("abort", onAbort);
				reject(new Error(`Timed out waiting for ${what}`));
			}, ms);
			signal?.addEventListener("abort", onAbort, { once: true });
			waiter = {
				match,
				resolve: (d) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolve(d);
				},
			};
		});

	window.addEventListener("message", onMessage);
	try {
		iframe.srcdoc = buildSlidesSrcdocFrom(parsed, channel, { ...opts, pdf: true });
		const ready = waitFor((t) => t === "chatui.slides.state", READY_TIMEOUT_MS, "the slides");
		document.body.appendChild(iframe);
		const state = await ready;
		const total = Number(state.total) || 1;
		if (total > MAX_SLIDES)
			throw new PdfTooLargeError(`A PDF can have at most ${MAX_SLIDES} slides`);
		const pages: PdfPage[] = [];
		let bytes = 0;
		for (let index = 0; index < total; index++) {
			if (signal?.aborted) throw abortError();
			const id = `p${index}`;
			const result = waitFor(
				(t, d) => t === "chatui.slides.captureResult" && d.id === id,
				SLIDE_TIMEOUT_MS,
				`slide ${index + 1}`
			);
			iframe.contentWindow?.postMessage(
				{ type: "chatui.slides.capture", channel, detail: { id, index, source } },
				"*"
			);
			const detail = await result;
			const dataUrl = detail.dataUrl;
			if (typeof detail.error === "string") throw new Error(detail.error);
			if (
				typeof dataUrl !== "string" ||
				!dataUrl.startsWith(JPEG_PREFIX) ||
				dataUrl.length > MAX_JPEG_DATA_URL
			) {
				throw new Error(`Slide ${index + 1} did not render`);
			}
			const jpeg = dataUrlToBytes(dataUrl);
			const size = jpegSize(jpeg);
			if (!size) throw new Error(`Slide ${index + 1} did not render`);
			bytes += jpeg.length;
			if (bytes > maxBytes) throw new PdfTooLargeError();
			pages.push({ jpeg, ...size });
			opts.onProgress?.(index + 1, total);
		}
		return buildPdf(pages, opts.title);
	} finally {
		window.removeEventListener("message", onMessage);
		iframe.remove();
	}
}
