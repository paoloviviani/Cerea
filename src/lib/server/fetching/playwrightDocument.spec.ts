import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("$lib/server/config", () => ({
	config: { PLAYWRIGHT_WS_ENDPOINT: "ws://playwright:3000/" },
}));
const connect = vi.fn();
vi.mock("playwright", () => ({ chromium: { connect } }));
const contentFetch = vi.fn();
vi.mock("$lib/server/urlSafety", () => ({
	contentFetch,
	isValidUrl: (u: string) => u.startsWith("https://"),
}));
vi.mock("$lib/server/files/extractDocument", () => ({
	documentMime: (m: string) => m,
	isExtractableDocument: (m: string) => m === "application/pdf",
}));

const { renderWithPlaywright } = await import("./playwright");

describe("renderWithPlaywright on a document", () => {
	beforeEach(() => vi.resetAllMocks());

	it("fetches a PDF through the SSRF guard as bytes and never opens the browser", async () => {
		contentFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
			const headers = { "content-type": "application/octet-stream" };
			return init?.method === "HEAD"
				? new Response(null, { headers })
				: new Response("%PDF-1.7 data", { headers });
		});
		const page = await renderWithPlaywright("https://x.test/pdf/9");
		expect(page.document?.mime).toBe("application/pdf");
		expect(page.backend).toBe("playwright");
		expect(connect).not.toHaveBeenCalled();
		expect(contentFetch).toHaveBeenCalledTimes(2);
	});
});
