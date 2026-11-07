/**
 * The vector PDF of a deck, made by the stack's boxed browser (the kit's
 * `fetch` profile: Playwright's Chromium with JavaScript on and its own
 * sandbox on, on a network of its own). Only where that service exists.
 *
 * The deck is a page of the user's own content and the browser is told to
 * trust none of it:
 *   - the document is handed over with `route.fulfill`, never fetched, so the
 *     browser has no reason to reach Cerea, and carries no credentials;
 *   - every request the page then makes is aborted, and the document's own
 *     policy (no network at all) says the same; a fresh context holds no
 *     cookies or storage;
 *   - a size limit on the input and the output, a time limit, and a small
 *     cap on how many renders run at once.
 */
import type { Browser } from "playwright";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { probePlaywrightHealth } from "$lib/server/fetching/playwright";

/** The address the deck is served from inside the browser: nothing real answers there. */
const DECK_URL = "https://deck.invalid/?print-pdf";

export const PDF_TIMEOUT_MS = 60_000;
export const PDF_MAX_BYTES = 100 * 1024 * 1024;
const MAX_CONCURRENT = 2;
let active = 0;

export class PdfUnavailableError extends Error {}
export class PdfBusyError extends Error {}
export class PdfTooLargeError extends Error {}
export class PdfTimeoutError extends Error {}

export interface RenderPdfOptions {
	timeoutMs?: number;
	maxBytes?: number;
	/** How to get a browser; the default connects to the stack's renderer */
	connect?: () => Promise<Browser>;
}

/** Whether a renderer is deployed and answering. */
export async function serverPdfAvailable(): Promise<boolean> {
	return (await probePlaywrightHealth()).reachable;
}

async function connectToRenderer(): Promise<Browser> {
	const endpoint = (config.PLAYWRIGHT_WS_ENDPOINT || "").trim();
	if (!endpoint) throw new PdfUnavailableError("No page renderer is configured");
	// Same pin as the fetch tool: connect() refuses a client of another minor version
	const { chromium } = await import("playwright");
	try {
		return await chromium.connect(endpoint, { timeout: 15_000 });
	} catch (err) {
		logger.warn({ err }, "slides_pdf_connect_failed");
		throw new PdfUnavailableError("Could not reach the page renderer");
	}
}

/** Render the print document to a PDF with real, selectable text. */
export async function renderDeckPdf(
	html: string,
	{ timeoutMs = PDF_TIMEOUT_MS, maxBytes = PDF_MAX_BYTES, connect }: RenderPdfOptions = {}
): Promise<Buffer> {
	if (active >= MAX_CONCURRENT) throw new PdfBusyError("Too many PDFs are being made");
	active++;
	let browser: Browser | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		browser = await (connect ?? connectToRenderer)();
		const opened = browser;
		const work = (async () => {
			const context = await opened.newContext({
				javaScriptEnabled: true,
				acceptDownloads: false,
				serviceWorkers: "block",
				viewport: { width: 1280, height: 720 },
			});
			await context.route("**/*", async (route) => {
				if (route.request().url() === DECK_URL) {
					await route
						.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html })
						.catch(() => {});
				} else {
					await route.abort("blockedbyclient").catch(() => {});
				}
			});
			const page = await context.newPage();
			await page.goto(DECK_URL, { waitUntil: "load", timeout: timeoutMs });
			await page.waitForSelector("html[data-print-ready]", {
				timeout: timeoutMs,
				state: "attached",
			});
			await page.evaluate(() => document.fonts.ready);
			const pdf = await page.pdf({
				width: "1280px",
				height: "720px",
				printBackground: true,
				margin: { top: "0", right: "0", bottom: "0", left: "0" },
				preferCSSPageSize: true,
			});
			await context.close().catch(() => {});
			return pdf;
		})();
		work.catch(() => {});
		const limit = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new PdfTimeoutError("The PDF took too long")), timeoutMs);
		});
		const pdf = await Promise.race([work, limit]);
		if (pdf.length > maxBytes) throw new PdfTooLargeError("The PDF is too large");
		return pdf;
	} finally {
		clearTimeout(timer);
		await browser?.close().catch(() => {});
		active--;
	}
}
