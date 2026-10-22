import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns";

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
vi.mock("$lib/server/logger", () => ({ logger }));
const config = { PLAYWRIGHT_WS_ENDPOINT: "ws://playwright:3000/" };
vi.mock("$lib/server/config", () => ({ config }));

const connect = vi.fn();
vi.mock("playwright", () => ({ chromium: { connect } }));

const httpGet = vi.fn();
vi.mock("node:http", () => ({ default: { get: (...args: unknown[]) => httpGet(...args) } }));
// playwright.ts reaches extractDocument through bytes.ts, and that module pulls
// in the database: with the config mock above carrying no MONGODB_URL it starts
// mongodb-memory-server, which crashes with SIGSEGV on CI runners without AVX
// (it failed the v0.15.6 release run). The allowlist helpers are all this needs.
vi.mock("$lib/server/files/extractDocument", () => ({
	documentMime: (m: string) => m,
	isExtractableDocument: (m: string) => m === "application/pdf",
}));

const {
	renderWithPlaywright,
	accessibilitySnapshotWithPlaywright,
	probePlaywrightHealth,
	MAX_CHARS,
} = await import("./playwright");

interface MockPage {
	goto: ReturnType<typeof vi.fn>;
	waitForLoadState: ReturnType<typeof vi.fn>;
	title: ReturnType<typeof vi.fn>;
	addScriptTag: ReturnType<typeof vi.fn>;
	evaluate: ReturnType<typeof vi.fn>;
	content: ReturnType<typeof vi.fn>;
	url: ReturnType<typeof vi.fn>;
	ariaSnapshot: ReturnType<typeof vi.fn>;
}

function makeHarness({
	responseOk = true,
	status = 200,
}: { responseOk?: boolean; status?: number } = {}) {
	const page: MockPage = {
		goto: vi.fn().mockResolvedValue({ ok: () => responseOk, status: () => status }),
		waitForLoadState: vi.fn().mockResolvedValue(undefined),
		title: vi.fn().mockResolvedValue("A title"),
		addScriptTag: vi.fn().mockResolvedValue(undefined),
		evaluate: vi.fn().mockResolvedValue(null),
		content: vi.fn().mockResolvedValue("<html><body>raw page</body></html>"),
		url: vi.fn().mockReturnValue("https://example.test/"),
		ariaSnapshot: vi.fn().mockResolvedValue("- generic [ref=e1]: hello"),
	};
	const context = {
		route: vi.fn().mockResolvedValue(undefined),
		newPage: vi.fn().mockResolvedValue(page),
		close: vi.fn().mockResolvedValue(undefined),
	};
	const browser = {
		newContext: vi.fn().mockResolvedValue(context),
		close: vi.fn().mockResolvedValue(undefined),
	};
	connect.mockResolvedValue(browser);
	return { page, context, browser };
}

describe("renderWithPlaywright", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("request interception", () => {
		async function routeHandler() {
			const { context } = makeHarness();
			await renderWithPlaywright("https://example.test/");
			expect(context.route).toHaveBeenCalledWith("**/*", expect.any(Function));
			return context.route.mock.calls[0][1] as (route: unknown) => Promise<void>;
		}
		function fakeRoute(url: string) {
			return {
				request: () => ({ url: () => url }),
				abort: vi.fn().mockResolvedValue(undefined),
				continue: vi.fn().mockResolvedValue(undefined),
			};
		}

		it("aborts a redirect hop or subresource aimed at an internal address", async () => {
			const handler = await routeHandler();
			for (const target of [
				"http://127.0.0.1:3000/chat",
				"https://192.168.1.10/",
				"http://169.254.169.254/latest/meta-data",
				"http://localhost/",
			]) {
				const route = fakeRoute(target);
				await handler(route);
				expect(route.abort).toHaveBeenCalled();
				expect(route.continue).not.toHaveBeenCalled();
			}
		});

		it("aborts a hostname that resolves to an internal address", async () => {
			const lookup = vi
				.spyOn(dns.promises, "lookup")
				.mockResolvedValue([{ address: "172.18.0.5", family: 4 }] as never);
			const handler = await routeHandler();
			const route = fakeRoute("http://gateway:8000/v1/models");
			await handler(route);
			expect(route.abort).toHaveBeenCalled();
			lookup.mockRestore();
		});

		it("lets a public page through", async () => {
			const lookup = vi
				.spyOn(dns.promises, "lookup")
				.mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
			const handler = await routeHandler();
			const route = fakeRoute("https://example.test/app.js");
			await handler(route);
			expect(route.continue).toHaveBeenCalled();
			expect(route.abort).not.toHaveBeenCalled();
			lookup.mockRestore();
		});
	});

	it("rejects an unsafe URL before ever connecting to the renderer", async () => {
		await expect(renderWithPlaywright("http://plain-http.test")).rejects.toThrow(
			/only HTTPS is supported/
		);
		expect(connect).not.toHaveBeenCalled();
	});

	it("surfaces a readable error when the renderer cannot be reached", async () => {
		connect.mockRejectedValue(new Error("ECONNREFUSED"));
		await expect(renderWithPlaywright("https://example.test/")).rejects.toThrow(
			/Could not reach the page renderer/
		);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error) }),
			"playwright_connect_failed"
		);
	});

	it("throws when the page answers with a non-ok status, and still closes context and browser", async () => {
		const { context, browser } = makeHarness({ responseOk: false, status: 404 });
		await expect(renderWithPlaywright("https://example.test/missing")).rejects.toThrow(
			"That URL answered 404."
		);
		expect(context.close).toHaveBeenCalled();
		expect(browser.close).toHaveBeenCalled();
	});

	it("does not fail the fetch when the post-load settle window times out", async () => {
		const { page } = makeHarness();
		page.waitForLoadState.mockRejectedValue(new Error("Timeout waiting for networkidle"));
		const result = await renderWithPlaywright("https://example.test/");
		expect(result.content).toContain("raw page");
	});

	it("uses the Readability extraction when it finds something, and marks the result as extracted", async () => {
		const { page } = makeHarness();
		page.evaluate.mockResolvedValue({
			title: "Article headline",
			content: "<p>Only the article body.</p>",
			textContent: "Only the article body.",
		});
		const result = await renderWithPlaywright("https://example.test/article");
		expect(result.content).toBe("<p>Only the article body.</p>");
		expect(result.extracted).toBe(true);
		expect(result.title).toBe("A title");
		expect(page.addScriptTag).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("function Readability") })
		);
	});

	it("falls back to the raw page when Readability finds nothing extractable", async () => {
		const { page } = makeHarness();
		page.evaluate.mockResolvedValue(null);
		const result = await renderWithPlaywright("https://example.test/dashboard");
		expect(result.content).toBe("<html><body>raw page</body></html>");
		expect(result.extracted).toBe(false);
	});

	it("falls back to the raw page when extraction itself throws, without failing the fetch", async () => {
		const { page } = makeHarness();
		page.evaluate.mockRejectedValue(new Error("script blocked by page CSP"));
		const result = await renderWithPlaywright("https://example.test/strict-csp");
		expect(result.content).toBe("<html><body>raw page</body></html>");
		expect(result.extracted).toBe(false);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(Error) }),
			"playwright_extraction_failed"
		);
	});

	it("truncates the extracted content, not the raw page, to MAX_CHARS", async () => {
		const { page } = makeHarness();
		// A raw page far larger than MAX_CHARS whose article is short: truncating
		// before extraction (the old order) would have cut this off long before
		// the article text below ever appears in the raw HTML.
		page.content.mockResolvedValue("x".repeat(MAX_CHARS * 2));
		const shortArticle = "Only the article body.";
		page.evaluate.mockResolvedValue({
			title: "Article headline",
			content: shortArticle,
			textContent: shortArticle,
		});
		const result = await renderWithPlaywright("https://example.test/huge-page");
		expect(result.content).toBe(shortArticle);

		// And extracted content that is itself too long is still capped.
		page.evaluate.mockResolvedValue({
			title: "Article headline",
			content: "y".repeat(MAX_CHARS + 100),
			textContent: "y".repeat(MAX_CHARS + 100),
		});
		const truncated = await renderWithPlaywright("https://example.test/huge-article");
		expect(truncated.content).toHaveLength(MAX_CHARS);
	});
});

describe("accessibilitySnapshotWithPlaywright", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the AI-mode aria snapshot", async () => {
		const { page } = makeHarness();
		const result = await accessibilitySnapshotWithPlaywright("https://example.test/article");
		expect(page.ariaSnapshot).toHaveBeenCalledWith(expect.objectContaining({ mode: "ai" }));
		expect(result.snapshot).toContain("ref=e1");
	});

	it("reflects content that only appears after the settle wait", async () => {
		const { page } = makeHarness();
		page.ariaSnapshot.mockResolvedValue("- generic [ref=e9]: loaded via ajax");
		const result = await accessibilitySnapshotWithPlaywright("https://example.test/scroll");
		expect(result.snapshot).toBe("- generic [ref=e9]: loaded via ajax");
	});

	it("shares the fetch's cleanup even when the settle wait times out", async () => {
		const { page, context, browser } = makeHarness();
		page.waitForLoadState.mockRejectedValue(new Error("Timeout waiting for networkidle"));
		await accessibilitySnapshotWithPlaywright("https://example.test/");
		expect(page.ariaSnapshot).toHaveBeenCalled();
		expect(context.close).toHaveBeenCalled();
		expect(browser.close).toHaveBeenCalled();
	});

	it("still throws on an unsafe URL before connecting", async () => {
		await expect(accessibilitySnapshotWithPlaywright("http://plain-http.test")).rejects.toThrow(
			/only HTTPS is supported/
		);
		expect(connect).not.toHaveBeenCalled();
	});
});

describe("probePlaywrightHealth", () => {
	// Each test starts comfortably past the 30s cache window relative to the
	// last, so a probe recorded by one test never leaks a cached answer into
	// the next — real time alone would not guarantee that gap.
	let epoch = Date.now();

	beforeEach(() => {
		epoch += 5 * 60_000;
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(epoch);
		httpGet.mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function respondWith(statusCode: number) {
		httpGet.mockImplementation(
			(_opts: unknown, callback: (res: { statusCode: number; resume: () => void }) => void) => {
				callback({ statusCode, resume: () => {} });
				return { on: vi.fn(), destroy: vi.fn() };
			}
		);
	}

	it("reports reachable on a 200 from the renderer's own port, derived from PLAYWRIGHT_WS_ENDPOINT", async () => {
		respondWith(200);
		const health = await probePlaywrightHealth();
		expect(health).toEqual({ reachable: true });
		// The mocked config names ws://playwright:3000/ (see the top-of-file
		// $lib/server/config mock): the same host the real connection targets,
		// since both read it from the one config value.
		expect(httpGet).toHaveBeenCalledWith(
			expect.objectContaining({ host: "playwright", port: 3000, path: "/" }),
			expect.any(Function)
		);
	});

	it("reports unreachable with the status when the port answers but not with 200", async () => {
		respondWith(503);
		const health = await probePlaywrightHealth();
		expect(health).toEqual({ reachable: false, reason: expect.stringContaining("503") });
	});

	it("reports not configured, without probing, when PLAYWRIGHT_WS_ENDPOINT is empty", async () => {
		config.PLAYWRIGHT_WS_ENDPOINT = "";
		try {
			const health = await probePlaywrightHealth();
			expect(health).toEqual({ reachable: false, reason: "not configured" });
			expect(httpGet).not.toHaveBeenCalled();
			await expect(renderWithPlaywright("https://example.org/")).rejects.toThrow(
				/No page renderer is configured/
			);
			expect(connect).not.toHaveBeenCalled();
		} finally {
			config.PLAYWRIGHT_WS_ENDPOINT = "ws://playwright:3000/";
		}
	});

	it("reports unreachable on a connection error", async () => {
		httpGet.mockImplementation(() => {
			const handlers: Record<string, (...a: unknown[]) => void> = {};
			const req = {
				on: (name: string, cb: (...a: unknown[]) => void) => {
					handlers[name] = cb;
					return req;
				},
				destroy: vi.fn(),
			};
			queueMicrotask(() => handlers.error?.(new Error("ECONNREFUSED")));
			return req;
		});
		const health = await probePlaywrightHealth();
		expect(health).toEqual({ reachable: false, reason: "ECONNREFUSED" });
	});

	it("reports unreachable, and destroys the request, on a timeout", async () => {
		const destroy = vi.fn();
		httpGet.mockImplementation(() => {
			const handlers: Record<string, (...a: unknown[]) => void> = {};
			const req = {
				on: (name: string, cb: (...a: unknown[]) => void) => {
					handlers[name] = cb;
					return req;
				},
				destroy,
			};
			queueMicrotask(() => handlers.timeout?.());
			return req;
		});
		const health = await probePlaywrightHealth();
		expect(health).toEqual({ reachable: false, reason: "timed out" });
		expect(destroy).toHaveBeenCalled();
	});

	it("caches a reachable result for repeated calls within the cache window", async () => {
		respondWith(200);
		await probePlaywrightHealth();
		respondWith(503); // Would answer differently if this were actually re-probed.
		const second = await probePlaywrightHealth();
		expect(second).toEqual({ reachable: true });
		expect(httpGet).toHaveBeenCalledTimes(1);
	});

	it("probes again once the cache window has passed", async () => {
		respondWith(200);
		await probePlaywrightHealth();
		vi.setSystemTime(epoch + 31_000);
		respondWith(503);
		const second = await probePlaywrightHealth();
		expect(second).toEqual({ reachable: false, reason: expect.stringContaining("503") });
		expect(httpGet).toHaveBeenCalledTimes(2);
	});
});
