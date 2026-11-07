/**
 * The one-click vector PDF of a slides artifact (ADR 0111), made by the
 * stack's boxed browser where the kit's `fetch` profile runs one. `GET` says
 * whether it is there; `POST` renders the deck sent in the body (the user's
 * own content, never looked up by id). Without the renderer the app offers
 * the print tab instead.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { buildPrintDocument, MAX_DECK_CHARS } from "$lib/server/slides/document";
import {
	PdfBusyError,
	PdfTimeoutError,
	PdfTooLargeError,
	PdfUnavailableError,
	renderDeckPdf,
	serverPdfAvailable,
} from "$lib/server/slides/renderPdf";
import { logger } from "$lib/server/logger";

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user && !locals.sessionId) error(401, "Login required");
	return json({ available: await serverPdfAvailable() });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user && !locals.sessionId) error(401, "Login required");
	const body = (await request.json().catch(() => null)) as {
		content?: unknown;
		logo?: unknown;
		notes?: unknown;
		title?: unknown;
	} | null;
	if (!body || typeof body.content !== "string" || !body.content.trim()) {
		error(400, "Send the deck as `content`.");
	}
	if (body.content.length > MAX_DECK_CHARS) error(413, "That deck is too large for a PDF.");
	if (!(await serverPdfAvailable())) error(501, "No page renderer is available.");
	const { html, title } = await buildPrintDocument({
		content: body.content,
		logo: typeof body.logo === "string" ? body.logo : undefined,
		print: { notes: body.notes === true },
	});
	try {
		const pdf = await renderDeckPdf(html);
		const name = `${
			title
				.replace(/[^\p{L}\p{N} _-]+/gu, "")
				.trim()
				.replace(/\s+/g, "-") || "slides"
		}.pdf`;
		return new Response(new Uint8Array(pdf), {
			headers: {
				"Content-Type": "application/pdf",
				"Content-Disposition": `attachment; filename="slides.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (err) {
		if (err instanceof PdfUnavailableError) error(501, "No page renderer is available.");
		if (err instanceof PdfBusyError)
			error(429, "Other PDFs are being made. Try again in a moment.");
		if (err instanceof PdfTooLargeError) error(413, "The PDF came out too large.");
		if (err instanceof PdfTimeoutError) error(504, "The PDF took too long to make.");
		logger.warn({ err }, "slides_pdf_failed");
		error(500, "The PDF could not be made.");
	}
};
