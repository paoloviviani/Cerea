/**
 * Fetch a URL by rendering it in a real browser.
 *
 * The renderer is a separate container on the compose network
 * (`deploy/compose/docker-compose.playwright.yml`), reached over Playwright's
 * `run-server` protocol. It runs no code of ours and publishes no port; see
 * `docs/browser.md` in the gateway repository for why it can never publish one.
 *
 * **The version pin is load-bearing.** `connect()` compares client and server
 * at *minor* granularity and refuses a mismatch with `428 Precondition
 * Required` — no browser, no fallback, no useful message unless somebody put
 * one here. That is why `package.json` pins `playwright` exactly rather than
 * with a caret: a caret range against this protocol is an outage waiting for an
 * unrelated `npm install`.
 *
 * The SSRF guard still applies. A browser is a far better SSRF primitive than
 * `fetch` — it follows redirects, runs scripts that can fetch again, and
 * resolves DNS itself — so the URL is checked before it is handed over. What
 * this cannot check is where the *page* then goes, which is the residual risk
 * of rendering at all and the reason the renderer has no credentials and sits
 * on no network but the compose one.
 */

import { isValidUrl } from "$lib/server/urlSafety";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import type { FetchedPage } from "./index";

/** Where the renderer listens. Inside the compose network only. */
function endpoint(): string {
	return (config.PLAYWRIGHT_WS_ENDPOINT || "ws://playwright:3000/").trim();
}

const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_CHARS = 10 * 1024 * 1024;

export async function renderWithPlaywright(url: string): Promise<FetchedPage> {
	if (!isValidUrl(url)) {
		throw new Error("Invalid or unsafe URL (only HTTPS is supported).");
	}

	// Imported here rather than at module scope: a deployment that never selects
	// this backend should not pay for loading the driver, and a missing package
	// should fail when somebody chooses the feature rather than at boot.
	const { chromium } = await import("playwright");

	let browser;
	try {
		browser = await chromium.connect(endpoint(), { timeout: 15_000 });
	} catch (err) {
		logger.warn({ err, endpoint: endpoint() }, "playwright_connect_failed");
		throw new Error(
			"Could not reach the page renderer. It may not be deployed — the playwright " +
				"compose overlay is opt-in — or its version may not match this app's."
		);
	}

	try {
		// A fresh context per fetch: no cookies, no storage and no state carried
		// from whatever the last person asked for. Two people fetching the same
		// site must not share a session.
		const context = await browser.newContext({
			userAgent: "Cerea-Chat-Fetcher/1.0",
			javaScriptEnabled: true,
		});
		const pageHandle = await context.newPage();
		try {
			// `domcontentloaded` rather than `networkidle`: the latter waits for
			// the network to go quiet, which on a page with polling or analytics
			// is never, and the timeout then reads as "the site is down".
			const response = await pageHandle.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: NAVIGATION_TIMEOUT_MS,
			});
			if (response && !response.ok()) {
				throw new Error(`That URL answered ${response.status()}.`);
			}

			const title = await pageHandle.title();
			const content = await pageHandle.content();
			return {
				url: pageHandle.url(),
				title: title.trim() || null,
				content: content.length > MAX_CHARS ? content.slice(0, MAX_CHARS) : content,
				contentType: "text/html",
				backend: "playwright",
			};
		} finally {
			await context.close().catch(() => {});
		}
	} finally {
		// Always. A leaked connection holds a browser context in the other
		// container for as long as this process runs, and its memory grows with
		// whatever page was open.
		await browser.close().catch(() => {});
	}
}
