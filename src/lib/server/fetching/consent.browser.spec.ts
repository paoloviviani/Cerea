/**
 * The consent step against a real Chromium and local fixture pages.
 *
 * The browser is launched as a Playwright server and reached with
 * `chromium.connect`, the way the chat reaches the renderer container, so that
 * what is proven is that autoconsent's injection and message bridge work over a
 * remote connection. Skipped where no Chromium is installed (the server test
 * job); the `client` job's image has one, and `playwright install chromium`
 * provides it locally.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type BrowserServer } from "playwright";

vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const { prepareConsent, handleConsent, CONSENT_BUDGET_MS } = await import("./consent");

const ARTICLE =
	"The council met on Tuesday to discuss the new bridge, its cost and the schedule for works.";

const page = (body: string, head = "") =>
	`<!doctype html><html><head><meta charset="utf-8">${head}</head><body style="margin:0">${body}</body></html>`;

const article = `<article id="a"><h1>Bridge</h1><p>${ARTICLE}</p></article>`;

const FIXTURES: Record<string, string> = {
	// A banner no autoconsent rule knows: a fixed, high z-index overlay with a Reject button.
	"/overlay": page(
		`<div id="b" style="position:fixed;inset:0;z-index:99999;background:#fff"><p>We use cookies and partners track you. Consent?</p>` +
			`<button onclick="window.clicked='reject'">Reject all</button></div>${article}`,
		"<style>html{overflow:hidden}</style>"
	),
	// The same inside a same-site consent iframe.
	"/framed": page(
		`<iframe src="/cmp/frame" style="position:fixed;inset:0;width:100%;height:100%;z-index:99999;border:0"></iframe>${article}`
	),
	"/cmp/frame": page(`<p>Cookies and consent</p><button>Reject all</button>`),
	// iubenda's markup, which autoconsent has a rule for. The article exists only after the click.
	"/iubenda": page(
		`<div id="iubenda-cs-banner" style="position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#eee">` +
			`<p>Cookies</p><button class="iubenda-cs-accept-btn" onclick="window.clicked='accept'">Accept</button>` +
			`<button class="iubenda-cs-reject-btn" onclick="window.clicked='reject';this.closest('#iubenda-cs-banner').remove();document.getElementById('root').innerHTML=document.getElementById('t').innerHTML">Reject</button></div>` +
			`<div id="root"></div><template id="t">${article}</template>`
	),
	"/plain": page(article),
};

let server: http.Server;
let base = "";
let browserServer: BrowserServer | undefined;
let browser: Browser | undefined;
const hasChromium = existsSync(chromium.executablePath());

beforeAll(async () => {
	if (!hasChromium) return;
	server = http.createServer((req, res) => {
		const body = FIXTURES[req.url ?? ""];
		res.writeHead(body ? 200 : 404, { "content-type": "text/html" });
		res.end(body ?? "");
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	browserServer = await chromium.launchServer({ headless: true });
	browser = await chromium.connect(browserServer.wsEndpoint());
}, 60_000);

afterAll(async () => {
	await browser?.close().catch(() => {});
	await browserServer?.close().catch(() => {});
	await new Promise((r) => server?.close(r));
});

async function read(path: string) {
	if (!browser) throw new Error("no browser");
	const context = await browser.newContext();
	try {
		const session = await prepareConsent(context, base + path);
		const p = await context.newPage();
		await p.goto(base + path, { waitUntil: "domcontentloaded" });
		const started = Date.now();
		const report = await handleConsent(p, session);
		const ms = Date.now() - started;
		const text = await p.evaluate(() => document.body.innerText);
		const clicked = await p.evaluate(
			() => (window as unknown as { clicked?: string }).clicked ?? null
		);
		const overflow = await p.evaluate(() => getComputedStyle(document.documentElement).overflow);
		return { report, text, clicked, ms, overflow, session };
	} finally {
		await context.close();
	}
}

describe.skipIf(!hasChromium)("consent step in a real browser, over a remote connection", () => {
	it("injects autoconsent into the page and its bridge answers", async () => {
		const r = await read("/plain");
		expect(r.session.ready).toBe(true);
		expect(r.session.messages.some((m) => m.type === "init")).toBe(true);
		expect(r.session.messages.some((m) => m.type === "autoconsentError")).toBe(false);
	});

	it("rejects an iubenda banner through autoconsent and reads the article that appears after", async () => {
		const r = await read("/iubenda");
		expect(r.report.rule).toBe("iubenda");
		expect(r.report.acted).toBe("autoconsent");
		expect(r.clicked).toBe("reject");
		expect(r.text).toContain(ARTICLE);
		expect(r.ms).toBeLessThan(5_500);
	});

	it("removes an overlay banner no rule knows, restores scrolling and keeps the article", async () => {
		const r = await read("/overlay");
		expect(r.report.acted).toBe("overlay");
		expect(r.report.overlaysRemoved).toBe(1);
		expect(r.clicked).toBeNull();
		expect(r.text).toContain(ARTICLE);
		expect(r.text).not.toContain("We use cookies");
		expect(r.overflow).not.toBe("hidden");
	});

	it("removes a fixed consent iframe", async () => {
		const r = await read("/framed");
		expect(r.report.overlaysRemoved).toBe(1);
		expect(r.text).toContain(ARTICLE);
	});

	it("does nothing on a page with no banner", async () => {
		const r = await read("/plain");
		expect(r.report).toMatchObject({ acted: "none", overlaysRemoved: 0 });
		expect(r.clicked).toBeNull();
		expect(r.text).toContain(ARTICLE);
		// No CMP: the detection window (2.5 s), not the whole budget.
		expect(r.ms).toBeLessThan(CONSENT_BUDGET_MS - 1_500);
	});
});
