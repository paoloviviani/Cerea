import DOMPurify from "isomorphic-dompurify";

/**
 * The docx preview pipeline shared by FileArtifactView (artifact panel) and
 * FileCard (side pane): docx-preview offscreen, then DOMPurify. A sibling of
 * $lib/utils/filePreview rather than a part of it — that module is imported
 * widely and must stay DOM-free, and a sibling keeps docx-preview and DOMPurify
 * out of the bundles of conversations without a docx in them.
 */

/**
 * Sanitize a docx-preview rendering. FORCE_BODY is load-bearing, not cosmetic:
 * docx-preview emits its <style> elements at the START of the container (its
 * renderAsync routes style nodes to a styleContainer that defaults to the body
 * container itself), and DOMPurify's default parsing puts a fragment that
 * begins with <style> into <head> — head content a body-fragment sanitizer
 * drops. That is how every font, size, paragraph style, list numbering and
 * table border silently vanished from the preview while the text survived.
 * Parsing the fragment as body content keeps the style block; ADD_TAGS pins
 * "style" in the allowlist beside it. Nothing else is loosened — the sandboxed
 * frame and the preview CSP stay the boundary, as for every preview.
 */
export function sanitizeDocxHtml(html: string): string {
	return DOMPurify.sanitize(html, { FORCE_BODY: true, ADD_TAGS: ["style"] });
}

/**
 * Render a Word document's bytes to sanitized HTML through docx-preview,
 * offscreen in a detached container — the renderer writes into a live element,
 * so its DOM is a means, not the destination.
 *
 * Size caps stay at the call sites: each one already checks before importing
 * the library, against the bytes it actually holds.
 */
export async function renderDocxPreview(bytes: Uint8Array): Promise<string> {
	// Dynamic import: the renderer must never enter the bundle of a
	// conversation without a docx in it.
	const { renderAsync } = await import("docx-preview");
	// slice() copies exactly the viewed range (bytes.buffer may overhang it,
	// transferable slices), and a Blob rather than a bare buffer because
	// docx-preview's jszip layer reads it through the File API.
	const blob = new Blob([bytes.slice()], {
		type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	});
	const container = window.document.createElement("div");
	await renderAsync(blob, container, undefined, {
		// The docx carries its own fonts, sizes and page geometry —
		// rendering those is the point of the swap; the previous
		// converter emitted a bare semantic fragment that had to be
		// styled by hand instead.
		inWrapper: true,
		ignoreWidth: false,
		ignoreHeight: false,
		ignoreFonts: false,
		breakPages: true,
		// Headers, footers, footnotes and endnotes are part of the page's
		// real layout — and docx-preview 0.4.x renders them by default, so
		// the earlier off-by-name posture was turning the library's own
		// default off. Changes and comments stay off: review markup is not
		// document content.
		renderHeaders: true,
		renderFooters: true,
		renderFootnotes: true,
		renderEndnotes: true,
		renderChanges: false,
		renderComments: false,
		// Images inline as data: URLs — the preview CSP allows exactly
		// data:/blob: for img-src, and this keeps the document self-contained
		useBase64URL: true,
	});
	// Checked before sanitizing: an empty render is a rendering problem worth
	// its own message, not a sanitizing one.
	if (!container.innerHTML.trim()) {
		throw new Error("the document rendered empty — download it to read the whole file");
	}
	return sanitizeDocxHtml(container.innerHTML);
}
