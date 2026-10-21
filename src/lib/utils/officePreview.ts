import { base } from "$app/paths";
import { FILE_PREVIEW_MAX_BYTES } from "./filePreview";
import type { FencePreview } from "$lib/stores/sidePane.svelte";

/**
 * The browser's half of Office previews. Two ways to a preview, one pane:
 *
 * - **With a converter** the server turns the file into a PDF (made on the
 *   first view and kept, `server/office/previewStore.ts`) and `<file url>/preview`
 *   serves it; it goes through the same PDF path as any PDF.
 * - **Without one** a PowerPoint deck is drawn here, slide by slide, by
 *   pptx-glimpse (`pptxPreview.ts`), as images.
 */

/** Where a stored file's PDF preview is served: the file's own URL plus `/preview`. */
export function previewUrlFor(fileUrl: string, name?: string): string {
	const query = name ? `?name=${encodeURIComponent(name)}` : "";
	return `${fileUrl}/preview${query}`;
}

/** Whether the deployment converts Office files (the layout's flag). */
export function officePreviewEnabledIn(data: unknown): boolean {
	return (data as { officePreviewEnabled?: unknown } | null)?.officePreviewEnabled === true;
}

function dataUrlOf(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () =>
			reader.error ? reject(reader.error) : reject(new Error("the preview is unavailable"));
		reader.readAsDataURL(blob);
	});
}

/** The PDF the server made of a file, as a `data:` URL typed application/pdf. */
export async function fetchPreviewPdfDataUrl(previewUrl: string): Promise<string> {
	const res = await fetch(previewUrl);
	if (!res.ok) {
		let message = "the preview is unavailable; the download still works";
		try {
			const body = (await res.json()) as { message?: unknown };
			if (typeof body.message === "string" && body.message) message = body.message;
		} catch {
			// Not JSON: the generic sentence stands.
		}
		throw new Error(message);
	}
	const blob = await res.blob();
	if (blob.size > FILE_PREVIEW_MAX_BYTES) {
		throw new Error("too large to preview — download it to read the whole document");
	}
	return dataUrlOf(new Blob([blob], { type: "application/pdf" }));
}

/** The side-pane payload for a converted file. */
export async function pdfPayloadFor(name: string, previewUrl: string): Promise<FencePreview> {
	return { kind: "pdf", title: name, content: await fetchPreviewPdfDataUrl(previewUrl) };
}

/** The side-pane payload for a deck drawn in the browser. */
export async function slidesPayloadFor(name: string, bytes: Uint8Array): Promise<FencePreview> {
	const { renderPptxPreview } = await import("./pptxPreview");
	const preview = await renderPptxPreview(bytes, { fontBase: `${base}/fonts/office` });
	return {
		kind: "slides",
		title: name,
		content: "",
		slides: preview.slides,
		note: preview.note,
		details: preview.details,
	};
}
