/**
 * Fetching a URL as bytes, and telling documents from pages.
 *
 * A PDF (or Word, Excel, PowerPoint, epub) is not text: reading its body as
 * text gives the model binary garbage, and a browser navigated to one starts a
 * download or opens a viewer. Both backends therefore go through here for
 * anything that is not plainly a page: the bytes are fetched through the SSRF
 * guard, and a document is handed back as bytes for the caller to extract with
 * the same reader an attached file uses (`extractDocument`).
 *
 * A document is recognised by its **bytes**, not only by the content type: a
 * PDF served as `application/octet-stream` (common on download endpoints) is
 * still a PDF.
 */

import { fileTypeFromBuffer } from "file-type";
import { contentFetch, isValidUrl } from "$lib/server/urlSafety";
import { documentMime, isExtractableDocument } from "$lib/server/files/extractDocument";
import type { FetchBackend, FetchedPage } from "./index";

export const TIMEOUT_MS = 30_000;
export const MAX_BYTES = 10 * 1024 * 1024;
const USER_AGENT = "Cerea-Chat-Fetcher/1.0";

export interface FetchedBytes {
	/** Final URL after redirects. */
	url: string;
	contentType: string;
	bytes: ArrayBuffer;
	/** True when the body was longer than `MAX_BYTES` and has been cut. */
	cut: boolean;
}

function assertValid(url: string): void {
	if (!isValidUrl(url, { blockInternalNetworks: true })) {
		throw new Error("Invalid or unsafe URL (only HTTPS is supported).");
	}
}

/** A GET through the SSRF guard, body read as bytes, capped at `MAX_BYTES`. */
export async function fetchBytes(url: string): Promise<FetchedBytes> {
	assertValid(url);
	const response = await contentFetch(url, {
		headers: { "user-agent": USER_AGENT },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`That URL answered ${response.status}.`);
	}
	const contentType = response.headers.get("content-type") ?? "application/octet-stream";
	const whole = await response.arrayBuffer();
	const cut = whole.byteLength > MAX_BYTES;
	return {
		url: response.url || url,
		contentType,
		bytes: cut ? whole.slice(0, MAX_BYTES) : whole,
		cut,
	};
}

/**
 * The content type a URL answers with, from a HEAD through the SSRF guard, or
 * null when that cannot be told (a server that refuses HEAD, a timeout). Null
 * is not an error: the caller carries on as it would have without the probe.
 */
export async function probeContentType(url: string): Promise<string | null> {
	assertValid(url);
	try {
		const response = await contentFetch(url, {
			method: "HEAD",
			headers: { "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(10_000),
		});
		await response.body?.cancel().catch(() => {});
		if (!response.ok) return null;
		return response.headers.get("content-type");
	} catch {
		return null;
	}
}

/** Whether a content type is a page a browser should render (or plain text), rather than a download. */
export function isPageContentType(contentType: string): boolean {
	const type = contentType.split(";")[0].trim().toLowerCase();
	return (
		type === "" ||
		type.startsWith("text/") ||
		type === "application/xhtml+xml" ||
		type === "application/xml" ||
		type === "application/json" ||
		type.endsWith("+json") ||
		type.endsWith("+xml")
	);
}

function filenameOf(url: string, mime: string): string {
	let name = "";
	try {
		name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
	} catch {
		// keep the fallback below
	}
	if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
	const ext = mime === "application/pdf" ? "pdf" : "bin";
	return `${name || "document"}.${ext}`;
}

/**
 * The extractable document type these bytes are, or null when they are not
 * one. Decided by the bytes alone, so a mislabelled error page (an HTML body
 * under `application/pdf`) is read as the page it is.
 */
export async function sniffDocument(bytes: ArrayBuffer, url: string): Promise<string | null> {
	const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024));
	// `%PDF-` may follow a few junk bytes; the spec allows it within the first 1024.
	if (new TextDecoder("latin1").decode(head).includes("%PDF-")) return "application/pdf";
	const sniffed = await fileTypeFromBuffer(new Uint8Array(bytes));
	if (!sniffed) return null;
	const mime = documentMime(sniffed.mime, filenameOf(url, sniffed.mime));
	return isExtractableDocument(mime) ? mime : null;
}

function decodeText(bytes: ArrayBuffer, contentType: string): string {
	const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

/** Title of an HTML page, to label the result with. */
function titleOf(html: string): string | null {
	const match = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
	return match ? match[1].trim().replace(/\s+/g, " ") || null : null;
}

/** A fetched body as a `FetchedPage`: a document carries its bytes, anything else is decoded as text. */
export async function pageFromBytes(
	fetched: FetchedBytes,
	backend: FetchBackend
): Promise<FetchedPage> {
	const mime = await sniffDocument(fetched.bytes, fetched.url);
	if (mime) {
		if (fetched.cut) {
			throw new Error(
				`That document is larger than ${MAX_BYTES / (1024 * 1024)} MB, which is more than can be read.`
			);
		}
		const filename = filenameOf(fetched.url, mime);
		return {
			url: fetched.url,
			title: filename,
			content: "",
			contentType: mime,
			backend,
			extracted: false,
			document: { bytes: fetched.bytes, mime, filename },
		};
	}
	const content = decodeText(fetched.bytes, fetched.contentType);
	return {
		url: fetched.url,
		title: titleOf(content),
		content,
		contentType: fetched.contentType,
		backend,
		extracted: false,
	};
}
