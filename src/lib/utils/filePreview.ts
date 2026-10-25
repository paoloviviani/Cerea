import { m } from "$lib/paraglide/messages";
import { formatNumber } from "$lib/i18n/format";
/**
 * Renderer selection for files a run generated — the single place that
 * decides how a filename previews, so the file cards, the one-shot
 * side-panel preview and the artifact panel's file view cannot drift.
 *
 * The security posture travels with the selection:
 * - `pdf` is drawn in the page by pdf.js (lazy-loaded, its worker served
 *   from this origin), under an 8 MB cap, the same on every device;
 * - `docx` renders through docx-preview offscreen and is sanitised with
 *   DOMPurify before it reaches any panel;
 * - `office` is a Word, Excel, PowerPoint or OpenDocument file the server
 *   turned into a PDF (Gotenberg, when the deployment has it): the PDF then
 *   goes through the `pdf` path above;
 * - `pptx` is a PowerPoint deck drawn in the browser by pptx-glimpse, as
 *   images (never as live SVG markup), when there is no converter;
 * - anything else is metadata plus the download, which is always available.
 */

import { isOfficeDocument } from "./officeFormats";

export type FilePreviewKind = "text" | "image" | "pdf" | "docx" | "office" | "pptx" | "none";

/** A pdf travels whole (the viewer needs every byte) as a data: URL, so the
 * same cap applies: base64 inflates a third on top. */
export const FILE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/** Inline text previews are capped to a head excerpt; the download has it all. */
export const FILE_PREVIEW_TEXT_CHARS = 4000;

/** Text previews refuse files past this size without fetching them. */
export const FILE_PREVIEW_TEXT_MAX_BYTES = 2 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
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
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

const INLINE_RASTER_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const INLINE_RASTER_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * The one rule for what may show as an image without being asked: raster
 * png/jpeg/gif/webp. SVG is script-capable and never qualifies, nor do the
 * formats a browser may not decode (bmp, avif) — those keep the click-to-
 * preview and the download.
 */
export function isInlineRasterImage(name: string): boolean {
	return INLINE_RASTER_EXTENSIONS.has(fileExtensionOf(name));
}

/** The same rule for a MIME type a server reported. */
export function isInlineRasterMime(mime: string | undefined): boolean {
	return mime !== undefined && INLINE_RASTER_MIMES.has(mime.toLowerCase());
}

/** Lower-cased extension without the dot, or "" when the name has none. */
export function fileExtensionOf(name: string): string {
	const base = name.split("/").pop() || name;
	if (!base.includes(".")) return "";
	return base.split(".").pop()?.toLowerCase() ?? "";
}

/**
 * Which renderer a filename gets. Direct-emission blocks carry their own
 * text (a zip cannot hide in there), so `docx` is only offered for real
 * byte sources — pass `fromBytes: false` for inline content.
 */
export function filePreviewKindFor(
	name: string,
	options: {
		fromBytes?: boolean;
		/**
		 * The server can convert this file: the deployment has a converter AND
		 * the file is in the server's store (a path the preview route serves).
		 */
		officePreview?: boolean;
	} = {}
): FilePreviewKind {
	const { fromBytes = true, officePreview = false } = options;
	const extension = fileExtensionOf(name);
	if (TEXT_EXTENSIONS.has(extension)) return "text";
	if (IMAGE_EXTENSIONS.has(extension)) return "image";
	if (extension === "pdf") return "pdf";
	if (officePreview && fromBytes && isOfficeDocument(name)) return "office";
	// Without a converter a deck still draws in the browser, from any byte source.
	if (extension === "pptx") return fromBytes ? "pptx" : "none";
	// Word documents render through docx-preview from fetched bytes, so every
	// byte source qualifies — live sandbox, persisted store, replay.
	if (extension === "docx") return fromBytes ? "docx" : "none";
	return "none";
}

/**
 * The one preview plan for a file, the same on a desktop and a phone: nothing
 * in it asks what device this is. A deck or document the server can convert
 * (the deployment has a converter AND the file is in the store) previews as
 * the server's PDF, drawn in the page by pdf.js; `fallback` is what draws it
 * from the bytes when that conversion is unavailable or fails. Without a
 * converter a deck is drawn by pptx-glimpse and a Word file by docx-preview.
 * A PDF is drawn by pdf.js. Everything else keeps its own renderer.
 */
export function previewPlan(
	name: string,
	options: { converter: boolean; stored: boolean; fromBytes?: boolean }
): { kind: FilePreviewKind; fallback?: FilePreviewKind } {
	const fromBytes = options.fromBytes ?? true;
	const kind = filePreviewKindFor(name, {
		fromBytes,
		officePreview: options.converter && options.stored,
	});
	if (kind !== "office") return { kind };
	const fallback = filePreviewKindFor(name, { fromBytes, officePreview: false });
	return fallback === "none" ? { kind } : { kind, fallback };
}

/**
 * Content type for a preview blob. Chrome's PDF viewer only engages for
 * application/pdf: a typeless blob navigated in the preview iframe downloads
 * instead of rendering, which is exactly the blank-frame-plus-download
 * failure. Images sniff either way, but an explicit type costs nothing and
 * states what the bytes are.
 */
export function filePreviewMimeType(extension: string): string {
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

/** Byte units are symbols, not words: the number goes through `Intl`, the unit stays. */
export function formatFileSize(bytes: number): string {
	const tenth = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
	// i18n: literal (unit symbols)
	if (bytes < 1024) return `${formatNumber(bytes)} B`;
	// i18n: literal (unit symbols)
	if (bytes < 1024 * 1024) return `${formatNumber(bytes / 1024, tenth)} KB`;
	// i18n: literal (unit symbols)
	return `${formatNumber(bytes / (1024 * 1024), tenth)} MB`;
}

export type FileKind =
	| "pdf"
	| "spreadsheet"
	| "markdown"
	| "data"
	| "image"
	| "code"
	| "word"
	| "slides"
	| "text"
	| "file";

/**
 * The kind a produced file is, from its name (see `fileKindLabel` for the
 * words). `mime` only backs the untyped fallback for callers that have it (a
 * stored row does; a bare filename does not).
 */
export function fileKindOf(name: string, mime?: string): FileKind {
	const extension = name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
	switch (extension) {
		case "pdf":
			return "pdf";
		case "csv":
		case "tsv":
		case "xls":
		case "xlsx":
		case "ods":
			return "spreadsheet";
		case "md":
		case "markdown":
			return "markdown";
		case "json":
		case "jsonl":
		case "yaml":
		case "yml":
		case "toml":
			return "data";
		case "png":
		case "jpg":
		case "jpeg":
		case "gif":
		case "webp":
		case "svg":
		case "bmp":
		case "avif":
			return "image";
		case "py":
		case "js":
		case "ts":
		case "html":
		case "xml":
		case "tex":
			return "code";
		case "doc":
		case "docx":
		case "odt":
		case "rtf":
			return "word";
		case "ppt":
		case "pptx":
		case "odp":
			return "slides";
		case "txt":
		case "log":
			return "text";
		default:
			return mime?.split("/")[0] === "text" ? "text" : "file";
	}
}

/**
 * The kind badge a produced file carries, from its name — the same label the
 * library panel's file rows show, single-sourced here so the inline file
 * artifact card and the library row cannot drift.
 */
export function fileKindLabel(name: string, mime?: string): string {
	switch (fileKindOf(name, mime)) {
		case "pdf":
			return m["chat.file_kind.pdf"]();
		case "spreadsheet":
			return m["chat.file_kind.spreadsheet"]();
		case "markdown":
			return m["chat.file_kind.markdown"]();
		case "data":
			return m["chat.file_kind.data"]();
		case "image":
			return m["chat.file_kind.image"]();
		case "code":
			return m["chat.file_kind.code"]();
		case "word":
			return m["chat.file_kind.word"]();
		case "slides":
			return m["chat.file_kind.slides"]();
		case "text":
			return m["chat.file_kind.text"]();
		default:
			return m["chat.file_kind.file"]();
	}
}
