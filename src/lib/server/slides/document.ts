/**
 * A deck as a standalone print document (ADR 0111): reveal's print layout, one
 * 1280x720 page per slide, with the content policy in the document itself.
 * Used by the "Print / save as PDF" tab and by the server's vector PDF.
 *
 * The content comes from the request that asks for it (the user's own deck),
 * never from a stored record, so there is nothing here that could show one
 * user another's deck.
 */
import { highlightCode } from "$lib/utils/marked";
import { parseDeck, deckTitle } from "$lib/utils/slides/deck";
import { mightHaveMath } from "$lib/utils/slides/math";
import { buildSlidesSrcdocFrom, type PrintOptions } from "$lib/utils/slides/srcdoc";
import { sanitizeLogo } from "$lib/utils/slides/themes";
import { slideDefaults } from "$lib/server/slideDefaults";

/** Largest deck (and logo) the print routes accept, in characters. */
export const MAX_DECK_CHARS = 2_000_000;

export interface PrintDocumentInput {
	content: string;
	/** A data: URL for the deck's own logo, already read by the app */
	logo?: string;
	print: PrintOptions;
}

export async function buildPrintDocument(
	input: PrintDocumentInput
): Promise<{ html: string; title: string }> {
	const parsed = parseDeck(input.content);
	const logo = sanitizeLogo(input.logo);
	const math = mightHaveMath(input.content)
		? (await import("$lib/utils/slides/mathSupport")).math
		: undefined;
	const html = buildSlidesSrcdocFrom(parsed, "", {
		org: slideDefaults(),
		logoDataUrl: logo?.startsWith("data:") ? logo : undefined,
		highlight: highlightCode,
		math,
		print: input.print,
	});
	return { html, title: deckTitle(parsed) };
}
