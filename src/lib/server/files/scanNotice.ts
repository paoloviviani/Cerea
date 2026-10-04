import { SCAN_PAGE_MARKER } from "./extractDocument";
import type { MessageFile } from "$lib/types/Message";

type PageImages = NonNullable<MessageFile["pageImages"]>;

/** `[1,2,3,5]` → `1–3, 5`. */
function pageList(pages: number[]): string {
	const sorted = [...new Set(pages)].sort((a, b) => a - b);
	const runs: string[] = [];
	for (let i = 0; i < sorted.length;) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
		runs.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
		i = j + 1;
	}
	return runs.join(", ");
}

/**
 * The words that go with a PDF's image pages, for one turn.
 *
 * `sent` is whether this turn's model is being sent the images. The same
 * stored pages are worded either way, because the person can switch models
 * between turns: "attached as an image" must never be said to a model that was
 * not given one, and the truth must not be lost for one that was.
 */
export function scanNotice(name: string, scan: PageImages, sent: boolean): string {
	const pages = scan.files.map((file) => file.page);
	const list = pageList(pages);
	const plural = new Set(pages).size > 1;
	const allScan = scan.scannedTotal >= scan.pageCount;
	if (!sent) {
		return (
			`PDF ${name}: ${plural ? `pages ${list} are` : `page ${list} is`} a scan` +
			`${plural ? "" : ""} and the current model cannot read images, so ${plural ? "those pages were" : "that page was"} not sent. ` +
			`${allScan ? "The PDF has no text of its own. " : "The pages with text are below. "}` +
			`Say so rather than guessing at what ${plural ? "they say" : "it says"}, and suggest choosing a model that reads images or an OCR reader.`
		);
	}
	const lead = allScan
		? `Scanned PDF ${name}: ${plural ? `pages ${list}` : `page ${list}`} attached as ${plural ? "images" : "an image"}.`
		: `PDF ${name}: ${plural ? `pages ${list} are scans` : `page ${list} is a scan`}, attached as ${plural ? "images" : "an image"}; the other pages are text below.`;
	const shown = scan.files.length;
	return scan.truncated
		? `${lead} Only the first ${shown} image pages of ${scan.scannedTotal} were attached; the rest were not read.`
		: lead;
}

/** The page-ordered text with each image page's marker worded for this turn. */
export function wordScanMarkers(text: string, sent: boolean): string {
	return text.replace(SCAN_PAGE_MARKER, (_, page: string) =>
		sent
			? `Page ${page} is a scan, attached as an image.`
			: `Page ${page} is a scan; its image was not sent because the current model cannot read images.`
	);
}
