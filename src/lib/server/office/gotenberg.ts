/**
 * Gotenberg, the document converter of the deploy kit's `office` profile:
 * LibreOffice turns Word, Excel, PowerPoint and OpenDocument files into PDF,
 * Chromium turns HTML into PDF. The chat uses it for two things — previews of
 * Office files (`previewStore.ts`) and the `convert_document` tool.
 *
 * `CHAT_GOTENBERG_URL` says where it is; empty means the feature is off, and
 * every caller treats that as "not offered", never as an error.
 *
 * Gotenberg parses untrusted documents, so the stack runs it on an internal
 * network with no way out, and this client adds what only a client can: a
 * deadline on every call, a cap on what comes back, a check that it really is
 * a PDF, and a limit on how many conversions this server has in flight (the
 * converter itself works through them one by one and refuses a long queue).
 */

import { marked } from "marked";

import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { OFFICE_EXTENSIONS, extensionOf, isOfficeDocument } from "$lib/utils/officeFormats";

/**
 * The version of what the converter produced, part of every preview's cache
 * key (`previewStore.ts`). Bump it whenever the way a document is converted
 * changes (Gotenberg's image, the LibreOffice options below): old previews
 * then stop matching and are made again on the next view.
 */
export const CONVERTER_VERSION = "gotenberg8.38-lo1";

/** One conversion gives up after this, whatever Gotenberg's own limit is. */
export const CONVERT_TIMEOUT_MS = 75_000;

/** The largest source file sent for conversion; larger ones are refused up front. */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/** The largest PDF read back; Gotenberg's output is otherwise unbounded. */
export const MAX_PDF_BYTES = 64 * 1024 * 1024;

/** The largest HTML or Markdown document the tool renders. */
export const MAX_HTML_BYTES = 2 * 1024 * 1024;

const MAX_CONCURRENT_CONVERSIONS = 3;

export { OFFICE_EXTENSIONS, extensionOf, isOfficeDocument };

const MIME_EXTENSION: Record<string, string> = {
	"application/msword": "doc",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.ms-excel": "xls",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/vnd.oasis.opendocument.text": "odt",
	"application/vnd.oasis.opendocument.spreadsheet": "ods",
	"application/vnd.oasis.opendocument.presentation": "odp",
	"application/rtf": "rtf",
	"text/rtf": "rtf",
};

/**
 * The file name to convert under, given what is stored: the stored type wins
 * (it was sniffed from the bytes when the file arrived), and the name's own
 * extension is the fallback. Undefined when neither says "Office document".
 */
export function officeFileName(
	mime: string | undefined,
	name: string | undefined
): string | undefined {
	const fromMime = mime ? MIME_EXTENSION[mime.split(";")[0].trim().toLowerCase()] : undefined;
	if (fromMime) return `document.${fromMime}`;
	if (name && isOfficeDocument(name)) return `document.${extensionOf(name)}`;
	return undefined;
}

/** The converter's base URL without a trailing slash, or "" when it is not configured. */
export function gotenbergUrl(): string {
	const raw = String(config.CHAT_GOTENBERG_URL ?? "").trim();
	if (!raw) return "";
	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return "";
		return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return "";
	}
}

export function isGotenbergEnabled(): boolean {
	return gotenbergUrl() !== "";
}

export type ConversionFailure =
	"unsupported" | "too_large" | "unavailable" | "busy" | "timeout" | "rejected" | "failed";

/** A conversion that did not produce a PDF; `message` is safe to show a person or a model. */
export class ConversionError extends Error {
	constructor(
		readonly kind: ConversionFailure,
		message: string
	) {
		super(message);
		this.name = "ConversionError";
	}
}

let inFlight = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (inFlight >= MAX_CONCURRENT_CONVERSIONS) {
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				const at = waiting.indexOf(go);
				if (at >= 0) waiting.splice(at, 1);
				reject(new ConversionError("timeout", "The conversion was cancelled."));
			};
			const go = () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			waiting.push(go);
		});
	}
	inFlight += 1;
	try {
		return await work();
	} finally {
		inFlight -= 1;
		waiting.shift()?.();
	}
}

async function post(route: string, form: FormData, signal?: AbortSignal): Promise<Buffer> {
	const base = gotenbergUrl();
	if (!base) throw new ConversionError("unavailable", "Document conversion is not configured.");
	const deadline = AbortSignal.timeout(CONVERT_TIMEOUT_MS);
	return withSlot(async () => {
		let response: Response;
		try {
			response = await fetch(`${base}${route}`, {
				method: "POST",
				body: form,
				signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
			});
		} catch (err) {
			if (deadline.aborted || (err instanceof Error && err.name === "TimeoutError")) {
				throw new ConversionError("timeout", "The conversion took too long and was stopped.");
			}
			if (signal?.aborted) throw new ConversionError("timeout", "The conversion was cancelled.");
			logger.warn({ err, route }, "gotenberg_unreachable");
			throw new ConversionError("unavailable", "The document converter is not reachable.");
		}
		if (!response.ok) {
			// Gotenberg's error bodies are short plain text; the log keeps them, the caller does not.
			const detail = (await response.text().catch(() => "")).slice(0, 300);
			logger.warn({ route, status: response.status, detail }, "gotenberg_conversion_refused");
			if (response.status === 503) {
				throw new ConversionError("busy", "The document converter is busy; try again shortly.");
			}
			if (response.status === 408 || response.status === 504) {
				throw new ConversionError("timeout", "The conversion took too long and was stopped.");
			}
			if (response.status >= 400 && response.status < 500) {
				throw new ConversionError(
					"rejected",
					"The converter could not read this file; it may be damaged or password-protected."
				);
			}
			throw new ConversionError("failed", "The converter failed on this file.");
		}
		const declared = Number(response.headers.get("content-length") ?? "0");
		if (declared > MAX_PDF_BYTES) {
			await response.body?.cancel().catch(() => undefined);
			throw new ConversionError("too_large", "The converted document is too large.");
		}
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.byteLength > MAX_PDF_BYTES) {
			throw new ConversionError("too_large", "The converted document is too large.");
		}
		if (bytes.byteLength < 5 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
			logger.warn({ route, bytes: bytes.byteLength }, "gotenberg_answer_not_pdf");
			throw new ConversionError("failed", "The converter did not return a PDF.");
		}
		return bytes;
	}, signal);
}

/**
 * An Office file to PDF through LibreOffice. The file travels under a name
 * made here — `document.<ext>` — because Gotenberg picks the importer from
 * the extension and a person's file name is not something to hand it.
 */
export async function convertOfficeToPdf(
	bytes: Uint8Array,
	name: string,
	options: { signal?: AbortSignal } = {}
): Promise<Buffer> {
	const ext = extensionOf(name);
	if (!OFFICE_EXTENSIONS.has(ext)) {
		throw new ConversionError("unsupported", `A .${ext || "?"} file cannot be converted to PDF.`);
	}
	if (bytes.byteLength > MAX_SOURCE_BYTES) {
		throw new ConversionError(
			"too_large",
			`The file is larger than the ${MAX_SOURCE_BYTES / (1024 * 1024)} MB conversion limit.`
		);
	}
	const form = new FormData();
	form.append("files", new Blob([Uint8Array.from(bytes)]), `document.${ext}`);
	return post("/forms/libreoffice/convert", form, options.signal);
}

/**
 * The page the Chromium route renders. The browser has no way out (the
 * `office` network is internal, and Gotenberg refuses non-public addresses),
 * JavaScript is off in the container's flags, and this adds the third layer:
 * a policy that allows inline styles and data: images and nothing else, and
 * the tags that load or run something are dropped before it gets there.
 */
export function htmlPage(body: string, title = "Document"): string {
	const stripped = body
		.replace(/<(script|iframe|object|embed|frame|frameset|applet)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<(script|iframe|object|embed|frame|frameset|applet|link|base|meta)\b[^>]*>/gi, "");
	const escapedTitle = title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
	return (
		`<!doctype html><html><head><meta charset="utf-8">` +
		`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">` +
		`<title>${escapedTitle}</title><style>${DOCUMENT_CSS}</style></head><body>${stripped}</body></html>`
	);
}

const DOCUMENT_CSS =
	"body{font:11pt/1.5 'Liberation Sans',Arial,sans-serif;color:#111;max-width:46em;margin:0 auto}" +
	"h1,h2,h3{line-height:1.25}pre,code{font-family:'Liberation Mono',monospace;font-size:.92em}" +
	"pre{background:#f4f4f5;padding:.7em;border-radius:4px;white-space:pre-wrap}" +
	"table{border-collapse:collapse}td,th{border:1px solid #999;padding:.25em .5em}" +
	"img{max-width:100%}blockquote{border-left:3px solid #bbb;margin-left:0;padding-left:1em;color:#444}";

/** Markdown to the HTML body `htmlPage` wraps. Raw HTML in it is stripped there, not trusted. */
export function markdownToHtml(markdown: string): string {
	return marked.parse(markdown, { async: false, gfm: true }) as string;
}

/**
 * HTML to PDF through Chromium. The document is one file (`index.html`), so
 * there is nothing for it to load: no assets are sent along, and anything it
 * names by URL fails, quietly, instead of failing the page.
 */
export async function convertHtmlToPdf(
	html: string,
	options: { title?: string; signal?: AbortSignal } = {}
): Promise<Buffer> {
	if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
		throw new ConversionError(
			"too_large",
			`The document is larger than the ${MAX_HTML_BYTES / (1024 * 1024)} MB limit.`
		);
	}
	const form = new FormData();
	form.append(
		"files",
		new Blob([htmlPage(html, options.title)], { type: "text/html" }),
		"index.html"
	);
	form.append("skipNetworkIdleEvent", "true");
	form.append("failOnResourceLoadingFailed", "false");
	form.append("printBackground", "true");
	form.append("paperWidth", "8.27");
	form.append("paperHeight", "11.7");
	form.append("marginTop", "0.7");
	form.append("marginBottom", "0.7");
	form.append("marginLeft", "0.7");
	form.append("marginRight", "0.7");
	return post("/forms/chromium/convert/html", form, options.signal);
}

/** Test seam: the number of conversions this process has in flight. */
export function conversionsInFlight(): number {
	return inFlight;
}
