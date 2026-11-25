/**
 * How many pages a PDF has, without sending it anywhere: what a page budget is checked against before
 * a read that is billed per page. Null when it cannot be told (damaged, encrypted, pdf.js unavailable):
 * the caller then does not guess.
 */
export async function pdfPageCount(
	bytes: Uint8Array,
	timeoutMs = PAGE_COUNT_TIMEOUT_MS
): Promise<number | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	try {
		return await Promise.race([count(bytes), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** A damaged or hostile PDF must not hold a turn: past this the count is simply unknown. */
export const PAGE_COUNT_TIMEOUT_MS = 5000;

async function count(bytes: Uint8Array): Promise<number | null> {
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
