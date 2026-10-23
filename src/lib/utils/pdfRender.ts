/**
 * pdf.js, loaded only when a PDF is opened. The library and its worker are
 * bundled into our own build (the worker as a hashed asset served from this
 * origin): no CDN, no remote script, nothing the page's policy has to allow
 * beyond its own origin.
 */
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

export type PdfDocument = PDFDocumentProxy;

let loading: Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> | undefined;

async function pdfjs() {
	loading ??= (async () => {
		const [lib, worker] = await Promise.all([
			import("pdfjs-dist/legacy/build/pdf.mjs"),
			import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
		]);
		lib.GlobalWorkerOptions.workerSrc = worker.default;
		return lib;
	})();
	return loading;
}

/** Decode a `data:` URL's payload without going through fetch. */
export function dataUrlBytes(dataUrl: string): Uint8Array {
	const comma = dataUrl.indexOf(",");
	const meta = dataUrl.slice(0, comma);
	const payload = dataUrl.slice(comma + 1);
	if (!meta.includes(";base64")) return new TextEncoder().encode(decodeURIComponent(payload));
	const binary = atob(payload);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Open a PDF from its bytes. The document takes ownership of a copy. */
export async function openPdf(
	bytes: Uint8Array
): Promise<{ doc: PdfDocument; destroy: () => Promise<void> }> {
	const lib = await pdfjs();
	const task = lib.getDocument({ data: bytes.slice(), enableXfa: false });
	const doc = await task.promise;
	return { doc, destroy: () => task.destroy() };
}
