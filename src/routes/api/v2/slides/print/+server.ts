/**
 * "Print / save as PDF" for a slides artifact (ADR 0111): the deck in reveal's
 * print layout, as a page of its own. The app opens it in a new tab by posting
 * a form here, so the content is whatever the user is looking at and nothing is
 * looked up by id (there is no way to ask for somebody else's deck).
 *
 * The page is protected by its response headers, not by a wrapper: the content
 * policy gives it no network, and `sandbox allow-scripts allow-modals` gives it
 * an opaque origin (no cookies, no storage, no access to Cerea) while letting
 * it call `window.print()`. Never a blob: URL from the app's own origin, which
 * would inherit that origin.
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { PRINT_HEADERS } from "$lib/server/slides/printHeaders";
import { buildPrintDocument, MAX_DECK_CHARS } from "$lib/server/slides/document";

const LABEL_MAX = 200;

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user && !locals.sessionId) error(401, "Login required");
	const form = await request.formData().catch(() => null);
	const content = form?.get("content");
	if (typeof content !== "string" || !content.trim()) error(400, "Send the deck as `content`.");
	if (content.length > MAX_DECK_CHARS) error(413, "That deck is too large to print.");
	const field = (name: string) => {
		const v = form?.get(name);
		return typeof v === "string" ? v : undefined;
	};
	const logo = field("logo");
	if (logo && logo.length > MAX_DECK_CHARS) error(413, "That logo is too large.");
	const { html } = await buildPrintDocument({
		content,
		logo,
		print: {
			notes: field("notes") === "1",
			auto: field("auto") !== "0",
			labels: {
				print: (field("labelPrint") ?? "Print or save as PDF").slice(0, LABEL_MAX),
				hint: (field("labelHint") ?? "").slice(0, LABEL_MAX),
			},
		},
	});
	return new Response(html, { headers: PRINT_HEADERS });
};
