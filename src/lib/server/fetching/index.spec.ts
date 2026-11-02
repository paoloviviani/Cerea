import { beforeEach, describe, expect, it, vi } from "vitest";

const config = { FETCH_BACKEND: "playwright" } as Record<string, string>;
vi.mock("$lib/server/config", () => ({ config }));
vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const fetchDirectDetailed = vi.fn();
const renderWithPlaywright = vi.fn();
vi.mock("./direct", () => ({
	fetchDirectDetailed,
	fetchDirect: async (u: string) => (await fetchDirectDetailed(u)).page,
}));
vi.mock("./playwright", () => ({ renderWithPlaywright }));

const { fetchPage } = await import("./index");

const url = "https://example.test/p";
const prose = "The council met on Tuesday to discuss the new bridge and its cost. ".repeat(20);
const direct = (html: string, extra: Record<string, unknown> = {}) => {
	const page = {
		url,
		title: "T",
		content: html,
		contentType: "text/html",
		backend: "direct",
		extracted: false,
		...extra,
	};
	return { page, raw: page };
};
const rendered = {
	url,
	title: "R",
	content: "<p>rendered</p>",
	contentType: "text/html",
	backend: "playwright",
	extracted: true,
};

describe("fetchPage with the playwright backend", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		config.FETCH_BACKEND = "playwright";
		renderWithPlaywright.mockResolvedValue(rendered);
	});

	it("uses the direct result when it is a real page", async () => {
		fetchDirectDetailed.mockResolvedValue(direct(`<p>${prose}</p>`));
		const page = await fetchPage(url);
		expect(page.backend).toBe("direct");
		expect(renderWithPlaywright).not.toHaveBeenCalled();
	});

	it("keeps a homepage of headlines on the direct path and gives the model the whole page", async () => {
		const raw = direct(
			`<ul>${Array.from({ length: 60 }, (_, i) => `<li><a href="/${i}">Headline ${i} of the day: the government announces a plan</a></li>`).join("")}</ul>`
		).page;
		// Readability kept one fragment of it.
		const page = { ...raw, content: "<p>Headline 1 of the day</p>", extracted: true };
		fetchDirectDetailed.mockResolvedValue({ page, raw });
		const result = await fetchPage(url);
		expect(result.backend).toBe("direct");
		expect(result.content).toBe(raw.content);
		expect(renderWithPlaywright).not.toHaveBeenCalled();
	});

	it("renders when the direct page is a consent notice", async () => {
		fetchDirectDetailed.mockResolvedValue(
			direct(
				`<p>${"We and our partners use cookies and tracking. Accept all or reject all, manage your preferences and consent. ".repeat(8)}</p>`
			)
		);
		expect((await fetchPage(url)).backend).toBe("playwright");
	});

	it("renders when the direct page is an empty JavaScript shell", async () => {
		fetchDirectDetailed.mockResolvedValue(
			direct(`<div id="root"></div><noscript>Enable JavaScript</noscript>`)
		);
		expect((await fetchPage(url)).backend).toBe("playwright");
	});

	it("renders when the direct fetch fails", async () => {
		fetchDirectDetailed.mockRejectedValue(new Error("That URL answered 403."));
		expect((await fetchPage(url)).backend).toBe("playwright");
	});

	it("renders when the direct fetch landed on a consent redirect", async () => {
		const consent = direct(`<p>${prose}</p>`, { url: "https://consent.google.com/ml" });
		fetchDirectDetailed.mockResolvedValue(consent);
		expect((await fetchPage(url)).backend).toBe("playwright");
	});

	it("returns a document from the direct fetch without a browser", async () => {
		const doc = {
			...direct("").page,
			contentType: "application/pdf",
			document: { bytes: new ArrayBuffer(1), mime: "application/pdf", filename: "a.pdf" },
		};
		fetchDirectDetailed.mockResolvedValue({ page: doc, raw: doc });
		expect((await fetchPage(url)).document).toBeDefined();
		expect(renderWithPlaywright).not.toHaveBeenCalled();
	});

	it("goes straight to the browser with render, without a direct attempt", async () => {
		const page = await fetchPage(url, { render: true });
		expect(page.backend).toBe("playwright");
		expect(fetchDirectDetailed).not.toHaveBeenCalled();
	});

	it("falls back to a thin direct page when the renderer fails", async () => {
		fetchDirectDetailed.mockResolvedValue(direct("<p>short</p>"));
		renderWithPlaywright.mockRejectedValue(new Error("down"));
		expect((await fetchPage(url)).backend).toBe("direct");
	});

	it("throws when both fail", async () => {
		fetchDirectDetailed.mockRejectedValue(new Error("403"));
		renderWithPlaywright.mockRejectedValue(new Error("down"));
		await expect(fetchPage(url)).rejects.toThrow("down");
	});

	it("never renders with the direct backend, render or not", async () => {
		config.FETCH_BACKEND = "direct";
		fetchDirectDetailed.mockResolvedValue(direct("<p>short</p>"));
		expect((await fetchPage(url, { render: true })).backend).toBe("direct");
		expect(renderWithPlaywright).not.toHaveBeenCalled();
	});
});
