import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltinToolResult } from "./types";

const fetchPage = vi.fn();

vi.mock("$lib/server/fetching", () => ({ fetchPage }));

const {
	createWebFetchBuiltin,
	MAX_FETCHES_PER_TURN,
	MAX_FETCH_RESULT_CHARS,
	readablePageText,
	urlsInUserText,
} = await import("./webFetchTool");

describe("web_fetch builtin", () => {
	beforeEach(() => vi.resetAllMocks());

	it("offers a separate, explicit page-reading function", () => {
		const tool = createWebFetchBuiltin({ allowedUrls: new Set() });
		expect(tool.name).toBe("web_fetch");
		expect(tool.definition.function.parameters?.required).toEqual(["url"]);
	});

	it("fetches a user-provided URL and gives the model bounded readable text", async () => {
		const url = "https://example.test/article";
		fetchPage.mockResolvedValue({
			url,
			title: "A page",
			content:
				"<html><style>hide</style><body><h1>Hello</h1><script>secret()</script><p>world</p></body></html>",
			contentType: "text/html",
			backend: "playwright",
		});
		const result = await createWebFetchBuiltin({ allowedUrls: new Set([url]) }).execute(
			{ url },
			{} as never
		);
		expect(result).toEqual({
			resultText: "Title: A page\nURL: https://example.test/article\n\nHello world",
		});
	});

	it("refuses a URL invented by the model before it reaches the renderer", async () => {
		const result = await createWebFetchBuiltin({ allowedUrls: new Set() }).execute(
			{ url: "https://metadata.example/secret" },
			{} as never
		);
		expect(result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("not supplied") })
		);
		expect(fetchPage).not.toHaveBeenCalled();
	});

	it("truncates page text before it is added to the model context", async () => {
		const url = "https://example.test/long";
		fetchPage.mockResolvedValue({
			url,
			title: null,
			content: "x".repeat(MAX_FETCH_RESULT_CHARS + 1),
			contentType: "text/plain",
			backend: "playwright",
		});
		const result = await createWebFetchBuiltin({ allowedUrls: new Set([url]) }).execute(
			{ url },
			{} as never
		);
		expect(result).toEqual(
			expect.objectContaining({ resultText: expect.stringContaining("[Content truncated.]") })
		);
	});

	it("limits page reads independently of the tool-round limit", async () => {
		const urls = Array.from(
			{ length: MAX_FETCHES_PER_TURN + 1 },
			(_, index) => `https://example.test/${index}`
		);
		fetchPage.mockResolvedValue({
			url: urls[0],
			title: null,
			content: "page",
			contentType: "text/plain",
			backend: "playwright",
		});
		const tool = createWebFetchBuiltin({ allowedUrls: new Set(urls) });
		const allowed: BuiltinToolResult[] = [];
		for (const url of urls.slice(0, -1)) {
			allowed.push(await tool.execute({ url }, {} as never));
		}
		expect(allowed).toHaveLength(MAX_FETCHES_PER_TURN);
		expect(allowed.at(-1)).toEqual({ resultText: expect.any(String) });
		expect(fetchPage).toHaveBeenCalledTimes(MAX_FETCHES_PER_TURN);
		expect(await tool.execute({ url: urls.at(-1) }, {} as never)).toEqual(
			expect.objectContaining({
				error: expect.stringContaining(`at most ${MAX_FETCHES_PER_TURN}`),
			})
		);
	});

	it("takes only HTTPS URLs from user text as initial fetch targets", () => {
		expect(urlsInUserText("Read https://example.test/a and http://unsafe.test/b")).toEqual([
			"https://example.test/a",
		]);
	});

	it("removes scripts and markup from rendered pages", () => {
		expect(readablePageText("<main>one &amp; two<script>three</script></main>")).toBe("one & two");
	});
});
