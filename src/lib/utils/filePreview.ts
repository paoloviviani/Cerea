/**
 * Renderer selection for files a run generated — the single place that
 * decides how a filename previews, so the chat `FileCard`, the one-shot
 * side-panel preview and the artifact panel's file view cannot drift.
 *
 * The security posture travels with the selection:
 * - `pdf` renders in the browser's native viewer framed WITHOUT the
 *   sandbox (Chrome and Safari refuse sandboxed PDF frames), from bytes
 *   this app typed `application/pdf`, under an 8 MB cap, with a mobile
 *   fallback for engines that draw no PDF in a frame;
 * - `docx` renders through docx-preview offscreen and is sanitised with
 *   DOMPurify before it reaches any panel;
 * - anything else is metadata plus the download, which is always available.
 */

export type FilePreviewKind = "text" | "image" | "pdf" | "docx" | "none";

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
	options: { fromBytes?: boolean } = {}
): FilePreviewKind {
	const { fromBytes = true } = options;
	const extension = fileExtensionOf(name);
	if (TEXT_EXTENSIONS.has(extension)) return "text";
	if (IMAGE_EXTENSIONS.has(extension)) return "image";
	if (extension === "pdf") return "pdf";
	// Word documents render through docx-preview from fetched bytes, so every
	// byte source qualifies — live sandbox, persisted store, replay.
	if (extension === "docx") return fromBytes ? "docx" : "none";
	return "none";
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

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The kind badge a produced file carries, from its name — the same label the
 * library panel's file rows show, single-sourced here so the inline file
 * artifact card and the library row cannot drift. `mime` only backs the
 * untyped fallback for callers that have it (a stored row does; a bare
 * filename does not).
 */
export function fileKindLabel(name: string, mime?: string): string {
	const extension = name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
	switch (extension) {
		case "pdf":
			return "PDF";
		case "csv":
		case "tsv":
			return "Spreadsheet";
		case "md":
		case "markdown":
			return "Markdown";
		case "json":
		case "jsonl":
		case "yaml":
		case "yml":
		case "toml":
			return "Data";
		case "png":
		case "jpg":
		case "jpeg":
		case "gif":
		case "webp":
		case "svg":
		case "bmp":
		case "avif":
			return "Image";
		case "py":
		case "js":
		case "ts":
		case "html":
		case "xml":
		case "tex":
			return "Code";
		case "docx":
			return "Word";
		case "txt":
		case "log":
			return "Text";
		default:
			return mime?.split("/")[0] === "text" ? "Text" : "File";
	}
}
