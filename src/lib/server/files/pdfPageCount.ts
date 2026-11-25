/**
 * How many pages a PDF has, without sending it anywhere: what a page budget is checked against before
 * a read that is billed per page. Null when it cannot be told (damaged, encrypted, pdf.js unavailable):
 * the caller then does not guess.
 */
export async function pdfPageCount(bytes: Uint8Array): Promise<number | null> {
	try {
		const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
		const task = pdfjs.getDocument({
			data: new Uint8Array(bytes),
			useSystemFonts: false,
			verbosity: 0,
		});
		try {
			const doc = await task.promise;
			const pages = doc.numPages;
			return Number.isInteger(pages) && pages > 0 ? pages : null;
		} finally {
			await task.destroy().catch(() => undefined);
		}
	} catch {
		return null;
	}
}
