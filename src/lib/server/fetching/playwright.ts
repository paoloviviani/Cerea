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

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import http from "node:http";
import { isValidUrl } from "$lib/server/urlSafety";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import type { FetchedPage } from "./index";
import type { Page } from "playwright";

/** Where the renderer listens. Inside the compose network only. */
function endpoint(): string {
	return (config.PLAYWRIGHT_WS_ENDPOINT || "ws://playwright:3000/").trim();
}

export interface PlaywrightHealth {
	reachable: boolean;
	/** Present only when unreachable — why, for the admin screen and the logs. */
	reason?: string;
}

const HEALTH_CACHE_MS = 30_000;
let cachedHealth: (PlaywrightHealth & { checkedAt: number }) | undefined;

/**
 * A plain HTTP GET expecting 200, on the renderer's own port — exactly the
 * shape of `run-server`'s own container healthcheck
 * (`require('http').get({host,port,timeout:4000}, r => r.statusCode === 200)`),
 * not a Playwright handshake and not a spawned browser. Host and port are
 * parsed from `PLAYWRIGHT_WS_ENDPOINT` rather than a second hardcoded
 * address, so the probe and the real connection can never point at
 * different places.
 */
function probeOnce(host: string, port: number): Promise<PlaywrightHealth> {
	return new Promise((resolve) => {
		const req = http.get({ host, port, path: "/", timeout: 4_000 }, (res) => {
			res.resume(); // Drain so the socket can close; the body is never read.
			resolve(
				res.statusCode === 200
					? { reachable: true }
					: { reachable: false, reason: `answered ${res.statusCode}` }
			);
		});
		req.on("timeout", () => {
			req.destroy();
			resolve({ reachable: false, reason: "timed out" });
		});
		req.on("error", (err) => resolve({ reachable: false, reason: err.message }));
	});
}

/**
 * Whether the configured renderer currently answers, cached for
 * `HEALTH_CACHE_MS` so assembling a tool list (once per turn) or loading the
 * admin screen does not probe on every call, while a renderer that came up
 * moments ago is still noticed within that window.
 *
 * **Deliberately not a one-time startup check, cached for the life of the
 * process.** That was considered and rejected: `run-server`'s own
 * healthcheck has a 60-second start period, and this chat routinely finishes
 * booting before the renderer is ready — a boot-time snapshot would report
 * "not deployed" against a stack that is about to become healthy, and stay
 * wrong until somebody restarted the chat. It fails in the other direction
 * too: the renderer can be stopped or removed after boot, and a cached
 * "available" from startup would keep advertising a tool that no longer
 * works. A short, repeatedly-refreshed cache is the only version of this
 * that stays honest for the life of the process; see `initServer` for the
 * one-off boot-time log line this does not replace.
 */
export async function probePlaywrightHealth(): Promise<PlaywrightHealth> {
	const now = Date.now();
	if (cachedHealth && now - cachedHealth.checkedAt < HEALTH_CACHE_MS) {
		return { reachable: cachedHealth.reachable, reason: cachedHealth.reason };
	}
	let host: string;
	let port: number;
	try {
		const url = new URL(endpoint());
		host = url.hostname;
		port = url.port ? Number(url.port) : 3000;
	} catch {
		const result: PlaywrightHealth = {
			reachable: false,
			reason: "PLAYWRIGHT_WS_ENDPOINT is not a valid URL",
		};
		cachedHealth = { ...result, checkedAt: now };
		return result;
	}
	const result = await probeOnce(host, port);
	cachedHealth = { ...result, checkedAt: now };
	return result;
}

const NAVIGATION_TIMEOUT_MS = 30_000;
// A bounded window given to client-side rendering after `domcontentloaded`,
// which fires before a React/Vue/etc. page has produced anything — the whole
// reason this renderer exists. `networkidle` is not used as the *navigation*
// condition (`goto`'s own `waitUntil`) because a page with polling or
// analytics never goes quiet and the navigation would then fail on timeout,
// reading as "the site is down". Waiting for it *after* navigation, capped and
// swallowed on timeout, gets the same settle without that failure mode: a page
// that goes idle sooner returns sooner, and one that never does still returns
// at the ceiling with whatever it has rendered by then.
const RENDER_SETTLE_TIMEOUT_MS = 4_000;
export const MAX_CHARS = 10 * 1024 * 1024;

let readabilityScript: string | undefined;

/**
 * The vendored Readability source (`@mozilla/readability`, Apache-2.0 —
 * `LICENSE.md` ships alongside it in the package), read once from
 * `node_modules` and injected into the page verbatim. This is script *we*
 * ship, not anything reaching this function from a model or a user: the rule
 * against server-side execution of model output is about who supplies the
 * code, not where it runs, and nothing here does either.
 */
function loadReadabilityScript(): string {
	if (readabilityScript === undefined) {
		const require = createRequire(import.meta.url);
		readabilityScript = readFileSync(
			require.resolve("@mozilla/readability/Readability.js"),
			"utf-8"
		);
	}
	return readabilityScript;
}

interface ReadabilityArticle {
	title: string | null;
	content: string;
}

interface ReadabilityCtor {
	new (doc: Document): { parse(): ReadabilityArticle | null };
}

/**
 * Runs Readability inside the page's own DOM rather than serializing the page
 * back to this process and re-parsing it with a second DOM implementation
 * (e.g. jsdom): the page already has a real, fully-scripted DOM built by the
 * browser, and that DOM is inside the isolated renderer container, not this
 * one. `null` is a normal outcome, not a failure — Readability is tuned for
 * articles, and a docs page, a forum thread, an index page or a dashboard can
 * legitimately produce nothing extractable.
 */
async function extractMainContent(pageHandle: Page): Promise<ReadabilityArticle | null> {
	await pageHandle.addScriptTag({ content: loadReadabilityScript() });
	return pageHandle.evaluate(() => {
		const ReadabilityInPage = (window as unknown as { Readability: ReadabilityCtor }).Readability;
		// Readability mutates the document it is given, so hand it a clone and
		// leave the live document alone for anything else read from the page.
		const clone = document.cloneNode(true) as Document;
		return new ReadabilityInPage(clone).parse();
	});
}

/**
 * Connect, navigate one page to `url`, run `render` against it, and always
 * tear down — the one isolation recipe every capture in this file shares: a
 * fresh context per call (no cookies, no storage, no state carried from
 * whatever the last caller asked for), and `finally` blocks that close the
 * context and the browser regardless of how `render` ends. A leaked
 * connection holds a browser context in the other container for as long as
 * this process runs, and its memory grows with whatever page was open.
 *
 * Navigation itself is shared too: `domcontentloaded` fires before
 * client-side rendering has produced anything, then a bounded, swallowed wait
 * for `networkidle` gives a React/Vue/etc. page room to finish without
 * letting a page with polling or analytics (which never goes idle) fail the
 * whole call the way using `networkidle` as `goto`'s own wait condition
 * would. A response that answered with a non-2xx status still throws before
 * `render` ever runs, for every caller.
 */
async function withRenderedPage<T>(url: string, render: (page: Page) => Promise<T>): Promise<T> {
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
		const context = await browser.newContext({
			userAgent: "Cerea-Chat-Fetcher/1.0",
			javaScriptEnabled: true,
		});
		const pageHandle = await context.newPage();
		try {
			const response = await pageHandle.goto(url, {
				waitUntil: "domcontentloaded",
				timeout: NAVIGATION_TIMEOUT_MS,
			});
			if (response && !response.ok()) {
				throw new Error(`That URL answered ${response.status()}.`);
			}

			await pageHandle
				.waitForLoadState("networkidle", { timeout: RENDER_SETTLE_TIMEOUT_MS })
				.catch(() => {});

			return await render(pageHandle);
		} finally {
			await context.close().catch(() => {});
		}
	} finally {
		await browser.close().catch(() => {});
	}
}

export async function renderWithPlaywright(url: string): Promise<FetchedPage> {
	return withRenderedPage(url, async (pageHandle) => {
		const title = await pageHandle.title();

		let content: string;
		let extracted: boolean;
		try {
			const article = await extractMainContent(pageHandle);
			if (article && article.content.trim()) {
				content = article.content;
				extracted = true;
			} else {
				content = await pageHandle.content();
				extracted = false;
			}
		} catch (err) {
			// A page whose CSP refuses the injected script, for instance. Falling
			// back to the raw page keeps the fetch itself from failing over an
			// extraction that was always a bonus on top of it.
			logger.warn({ err, url }, "playwright_extraction_failed");
			content = await pageHandle.content();
			extracted = false;
		}

		return {
			url: pageHandle.url(),
			title: title.trim() || null,
			// Truncated after extraction, not before: truncating the raw page
			// first can cut the content off before the article even begins, and
			// extraction is what makes the truncation land somewhere useful.
			content: content.length > MAX_CHARS ? content.slice(0, MAX_CHARS) : content,
			contentType: "text/html",
			backend: "playwright",
			extracted,
		};
	});
}

export interface PlaywrightAccessibilitySnapshot {
	url: string;
	title: string | null;
	snapshot: string;
}

/**
 * `page.accessibility` (the old `AccessibilitySnapshot` API) is gone from
 * this Playwright version's types entirely — checked in
 * `node_modules/playwright-core/types/types.d.ts` for 1.61.1 rather than
 * assumed from memory. `page.ariaSnapshot()` is its replacement, and
 * `mode: "ai"` is Playwright's own purpose-built shape for handing a page's
 * structure to a model: element roles, names and a stable `[ref=eN]` per
 * node, without the prose extraction `renderWithPlaywright` does.
 */
export async function accessibilitySnapshotWithPlaywright(
	url: string
): Promise<PlaywrightAccessibilitySnapshot> {
	return withRenderedPage(url, async (pageHandle) => {
		const title = await pageHandle.title();
		const snapshot = await pageHandle.ariaSnapshot({ mode: "ai" });
		return { url: pageHandle.url(), title: title.trim() || null, snapshot };
	});
}
