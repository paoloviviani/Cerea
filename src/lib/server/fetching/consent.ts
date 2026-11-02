/**
 * Getting past a cookie-consent notice in the renderer.
 *
 * A fresh browser context has no consent cookie, so most European sites put a
 * banner or a wall in front of the page, and nothing in the context clicks it.
 * Three steps, none of which may fail the fetch and all of which together are
 * bounded to `CONSENT_BUDGET_MS`:
 *
 * 1. **Pre-set cookies** for the big redirectors (Google, YouTube), on the
 *    context before the first navigation: `preConsentCookies`.
 * 2. **autoconsent** (DuckDuckGo, MPL-2.0, used unmodified): its content script
 *    is injected into every frame with `context.addInitScript`, and its message
 *    bridge is `context.exposeBinding("autoconsentSendMessage", ...)`. Both are
 *    ordinary Playwright protocol calls, so they work over `chromium.connect` to
 *    the remote run-server; no browser extension is involved. Configured to
 *    **opt out** (reject) with the cosmetic "hide the banner" rules off, so
 *    hiding is never the only action.
 * 3. **Overlay cleanup**: what is still covering the page after that, and has
 *    consent vocabulary, is removed before the text is extracted.
 *
 * A generic "click any button called Reject" step was considered and left out:
 * autoconsent's rules plus its own heuristic detection cover the common
 * banners, and one more way to click things is one more way to click the
 * wrong thing.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { BrowserContext, Cookie, Frame, Page } from "playwright";
import { logger } from "$lib/server/logger";

/** The most time the consent step may take, in all. */
export const CONSENT_BUDGET_MS = 5_000;
/**
 * How long to wait for a CMP to be detected before deciding there is none. The
 * script's own "nothingDetected" can end the wait sooner, but on a static page it
 * may never come: after its second try each retry also waits for a DOM change.
 */
const DETECT_WAIT_MS = 2_500;
const POLL_MS = 100;
const SETTLE_MS = 1_500;

// SOCS is Google's consent cookie, a base64 protobuf whose first field is the
// choice. `CAE=` is field 1 = 1, the "rejected" state; `CAI=` (field 1 = 2) is
// the accepted one. It replaced the legacy CONSENT cookie, which has no reject
// value (only `PENDING`/`YES+`), so that one is deliberately not set. Not
// verified against Google's own documentation, which does not publish it: it
// is the value reject-first scrapers use, and the overlay cleanup and
// autoconsent still run if Google ignores it.
const GOOGLE_SOCS_REJECT = "CAE=";
const GOOGLE_HOST = /^(?:[a-z0-9-]+\.)*(google\.(?:com?\.)?[a-z]{2,3})$/i;
const YOUTUBE_HOST = /^(?:[a-z0-9-]+\.)*(youtube\.com)$/i;

/** Consent cookies to set before navigating to `url`: only for Google and YouTube. */
export function preConsentCookies(url: string, now = Date.now()): Cookie[] {
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		return [];
	}
	const domain = (GOOGLE_HOST.exec(host) ?? YOUTUBE_HOST.exec(host))?.[1];
	if (!domain) return [];
	return [
		{
			name: "SOCS",
			value: GOOGLE_SOCS_REJECT,
			domain: `.${domain}`,
			path: "/",
			expires: Math.floor(now / 1000) + 60 * 60 * 24 * 390,
			httpOnly: false,
			secure: true,
			sameSite: "Lax",
		},
	];
}

/** What the step did, for the debug log and the tests. */
export interface ConsentReport {
	/** What acted: an autoconsent rule, an overlay removal, or nothing. */
	acted: "autoconsent" | "overlay" | "none";
	/** The autoconsent rule that detected a banner, when one did. */
	rule?: string;
	/** Whether autoconsent's opt-out succeeded. */
	rejected?: boolean;
	overlaysRemoved: number;
	cookies: string[];
}

/** A subset of autoconsent's content-script messages, as far as this reads them. */
interface ContentMessage {
	type: string;
	cmp?: string;
	result?: boolean;
	id?: string;
	code?: string;
	url?: string;
	/** On `report`: whether it came from the top frame, and the script's state. */
	mainFrame?: boolean;
	state?: { lifecycle?: string };
}

export interface ConsentSession {
	/** False when the setup failed: the step then does nothing. */
	ready: boolean;
	messages: ContentMessage[];
	cookies: string[];
}

interface AutoconsentAssets {
	script: string;
	rules: Parameters<typeof import("@duckduckgo/autoconsent").filterCompactRules>[0];
	filterCompactRules: typeof import("@duckduckgo/autoconsent").filterCompactRules;
}

let assets: Promise<AutoconsentAssets> | undefined;

/**
 * The package's own Playwright bundle and compact rule set, read once from
 * `node_modules` and injected verbatim. Script we ship, from a pinned version.
 * The bundle is not in the package's `exports` map, so it is found next to the
 * rules file, which is.
 */
function loadAssets(): Promise<AutoconsentAssets> {
	assets ??= (async () => {
		const require = createRequire(import.meta.url);
		const rulesPath = require.resolve("@duckduckgo/autoconsent/rules/compact-rules.json");
		const script = readFileSync(
			path.join(path.dirname(rulesPath), "..", "dist", "autoconsent.playwright.js"),
			"utf-8"
		);
		const rules = JSON.parse(readFileSync(rulesPath, "utf-8"));
		const { filterCompactRules } = await import("@duckduckgo/autoconsent");
		return { script, rules, filterCompactRules };
	})();
	// A failure is not remembered: the next fetch tries again.
	assets.catch(() => {
		assets = undefined;
	});
	return assets;
}

const AUTOCONSENT_CONFIG = {
	enabled: true,
	autoAction: "optOut",
	disabledCmps: [],
	enablePrehide: false,
	enableCosmeticRules: false,
	enableHeuristicDetection: true,
	// 500 ms apart (sooner on DOM changes): about 4 s to report "nothingDetected",
	// inside the step's budget. A CMP that loads late (iubenda) needs more than the
	// first second or two.
	detectRetries: 8,
	visualTest: false,
};

async function evaluateQuietly(frame: Frame, expression: string): Promise<unknown> {
	try {
		return await frame.evaluate(expression);
	} catch {
		return undefined; // The frame navigated or went away.
	}
}

/** Answers the content script's messages: the rules it should run, and the evals it cannot. */
async function bridge(
	a: AutoconsentAssets,
	session: ConsentSession,
	frame: Frame,
	msg: ContentMessage
) {
	session.messages.push(msg);
	if (msg.type === "init") {
		const rules = a.filterCompactRules(a.rules, {
			url: frame.url(),
			mainFrame: frame.parentFrame() === null,
		});
		await evaluateQuietly(
			frame,
			`autoconsentReceiveMessage({ type: "initResp", config: ${JSON.stringify(AUTOCONSENT_CONFIG)}, rules: ${JSON.stringify({ compact: rules })} })`
		);
	} else if (msg.type === "eval" && typeof msg.code === "string") {
		const result = await evaluateQuietly(frame, msg.code);
		await evaluateQuietly(
			frame,
			`autoconsentReceiveMessage({ id: ${JSON.stringify(msg.id)}, type: "evalResp", result: ${JSON.stringify(result ?? null)} })`
		);
	}
}

/**
 * Set up the context before the first navigation: cookies, then autoconsent in
 * every frame. Never throws; a failed setup is logged and the fetch goes on
 * without a consent step.
 */
export async function prepareConsent(
	context: BrowserContext,
	url: string
): Promise<ConsentSession> {
	const session: ConsentSession = { ready: false, messages: [], cookies: [] };
	try {
		const cookies = preConsentCookies(url);
		if (cookies.length > 0) {
			await context.addCookies(cookies);
			session.cookies = cookies.map((c) => `${c.name}@${c.domain}`);
		}
	} catch (err) {
		logger.warn({ err: String(err) }, "consent_cookies_failed");
	}
	try {
		const a = await loadAssets();
		await context.exposeBinding(
			"autoconsentSendMessage",
			async ({ frame }: { frame: Frame }, msg: ContentMessage) => {
				try {
					await bridge(a, session, frame, msg);
				} catch (err) {
					logger.warn({ err: String(err) }, "consent_bridge_failed");
				}
			}
		);
		await context.addInitScript({ content: a.script });
		session.ready = true;
	} catch (err) {
		logger.warn({ err: String(err) }, "consent_setup_failed");
	}
	return session;
}

const has = (s: ConsentSession, type: string) => s.messages.some((m) => m.type === type);

/** Words an overlay must contain to be taken for a consent notice. */
export const OVERLAY_VOCABULARY =
	"cookie|consent|gdpr|privacy|tracking|partners|datenschutz|einwilligung|consenso|consentement|consentimiento|toestemming|privacidade";

/**
 * Runs in the page. Removes fixed or sticky elements with a very high z-index
 * that carry consent vocabulary (and fixed consent iframes), never one that
 * contains an `<article>` or `<main>` or holds a long text; then, only if
 * something was removed or a banner was acted on, the empty full-viewport
 * backdrops and a scroll lock on `html` and `body`. Returns how many it removed.
 * A string, not a function, so the build cannot rewrite it before it is sent.
 */
const OVERLAY_CLEANUP = `(arg) => {
	const vocab = new RegExp(arg.vocab, "i");
	const consentFrame = /consent|cmp|privacy|cookie|gdpr/i;
	let removed = 0;
	const vw = window.innerWidth, vh = window.innerHeight;
	for (const el of Array.from(document.querySelectorAll("div,section,aside,dialog,form,iframe"))) {
		const cs = getComputedStyle(el);
		if (cs.position !== "fixed" && cs.position !== "sticky") continue;
		if ((parseInt(cs.zIndex, 10) || 0) < 1000) continue;
		if (el.tagName === "IFRAME") {
			if (!consentFrame.test(el.getAttribute("src") || "")) continue;
		} else {
			if (el.querySelector("article,main")) continue;
			const text = el.innerText || "";
			if (text.length > 3000 || !vocab.test(text)) continue;
		}
		el.remove();
		removed++;
	}
	if (removed > 0) {
		for (const el of Array.from(document.querySelectorAll("div,section,aside"))) {
			const cs = getComputedStyle(el);
			if (cs.position !== "fixed" || (parseInt(cs.zIndex, 10) || 0) < 1000) continue;
			if ((el.innerText || "").trim() !== "" || el.querySelector("img,video,canvas,iframe")) continue;
			const r = el.getBoundingClientRect();
			if (r.width >= vw * 0.9 && r.height >= vh * 0.9) { el.remove(); removed++; }
		}
	}
	if (removed > 0 || arg.acted) {
		for (const el of [document.documentElement, document.body]) {
			if (!el) continue;
			const o = getComputedStyle(el).overflow;
			if (o === "hidden" || o === "clip") el.style.setProperty("overflow", "auto", "important");
		}
	}
	return removed;
}`;

/**
 * The consent step proper, after navigation and before extraction. Waits for
 * autoconsent to act (or to find nothing), then cleans up what is left.
 * Bounded by `CONSENT_BUDGET_MS`; never throws.
 */
/** The latest lifecycle the top frame's content script reported, if any. */
function topLifecycle(session: ConsentSession): string | undefined {
	for (let i = session.messages.length - 1; i >= 0; i--) {
		const m = session.messages[i];
		if (m.type === "report" && m.mainFrame && m.state?.lifecycle) return m.state.lifecycle;
	}
	return undefined;
}

export async function handleConsent(page: Page, session: ConsentSession): Promise<ConsentReport> {
	const report: ConsentReport = { acted: "none", overlaysRemoved: 0, cookies: session.cookies };
	const started = Date.now();
	const remaining = () => Math.max(0, CONSENT_BUDGET_MS - (Date.now() - started));
	try {
		if (session.ready) {
			while (remaining() > 0) {
				if (has(session, "autoconsentDone") || has(session, "optOutResult")) break;
				// The top frame's own verdict ends the wait: nothing there, or done.
				const lifecycle = topLifecycle(session);
				if (lifecycle === "nothingDetected") break;
				if (!has(session, "cmpDetected") && Date.now() - started > DETECT_WAIT_MS) break;
				await new Promise((r) => setTimeout(r, POLL_MS));
			}
			const detected = session.messages.find((m) => m.type === "cmpDetected");
			report.rule = detected?.cmp;
			const result = session.messages.find((m) => m.type === "optOutResult");
			if (result) {
				report.rejected = result.result === true;
				if (report.rejected) report.acted = "autoconsent";
			}
			if (report.acted === "autoconsent") {
				// The page changes after a click: let it settle, bounded, not a fixed sleep.
				await page
					.waitForLoadState("networkidle", { timeout: Math.min(SETTLE_MS, remaining()) })
					.catch(() => {});
			}
		}
		const argument = JSON.stringify({
			vocab: OVERLAY_VOCABULARY,
			acted: report.acted === "autoconsent",
		});
		const removed = await page.evaluate(`(${OVERLAY_CLEANUP})(${argument})`).catch(() => 0);
		report.overlaysRemoved = typeof removed === "number" ? removed : 0;
		if (report.overlaysRemoved > 0 && report.acted === "none") report.acted = "overlay";
	} catch (err) {
		logger.warn({ err: String(err) }, "consent_step_failed");
	}
	try {
		logger.debug(
			{
				acted: report.acted,
				rule: report.rule ?? null,
				rejected: report.rejected ?? null,
				overlaysRemoved: report.overlaysRemoved,
				cookies: report.cookies,
				ms: Date.now() - started,
			},
			"fetch_consent_step"
		);
	} catch {
		// Logging is not worth a failed fetch.
	}
	return report;
}
