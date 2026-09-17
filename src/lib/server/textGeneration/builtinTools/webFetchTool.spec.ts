import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { BuiltinToolResult } from "./types";
import type { BuiltinToolContext } from "./types";

const fetchPage = vi.fn();

vi.mock("$lib/server/fetching", () => ({ fetchPage }));

const {
	createWebFetchBuiltin,
	webFetchNeedsApproval,
	MAX_FETCHES_PER_TURN,
	MAX_FETCH_RESULT_CHARS,
	readablePageText,
	urlsInUserText,
} = await import("./webFetchTool");

describe("web_fetch builtin", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

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

function fakeContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
	return {
		uuid: "call-uuid",
		toolCallId: "call-1",
		conversationId: new ObjectId(),
		messageId: "message-1",
		generationId: "gen-1",
		elicitationSink: { conversationId: new ObjectId(), emit: vi.fn() },
		...overrides,
	};
}

describe("webFetchNeedsApproval", () => {
	it("needs no approval for a URL already trusted by provenance", () => {
		expect(
			webFetchNeedsApproval(
				{ url: "https://known.test/page" },
				new Set(["https://known.test/page"])
			)
		).toBe(false);
	});

	it("needs approval for a URL nobody supplied", () => {
		expect(webFetchNeedsApproval({ url: "https://unseen.test/page" }, new Set())).toBe(true);
	});

	it("needs approval for an unparseable URL rather than silently passing it through", () => {
		expect(webFetchNeedsApproval({ url: "not a url" }, new Set())).toBe(true);
	});
});

describe("web_fetch: tool-approval gate (ADR 0075)", () => {
	beforeEach(() => vi.resetAllMocks());

	it("refuses an untrusted URL that reached execute() without being cleared by the gate", async () => {
		// The gate (toolInvocation.ts) is what opens the approval prompt; by the
		// time execute() runs for an untrusted URL, it must already be cleared —
		// this is the defensive fallback for anything that reaches it otherwise.
		const tool = createWebFetchBuiltin({ allowedUrls: new Set() });
		const result = await tool.execute({ url: "https://unseen.test/page" }, fakeContext());
		expect(result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("not approved") })
		);
		expect(fetchPage).not.toHaveBeenCalled();
	});

	it("fetches an untrusted URL once the conversation has approved web_fetch", async () => {
		const url = "https://known-later.test/page";
		fetchPage.mockResolvedValue({
			url,
			title: "Known later",
			content: "<p>hi</p>",
			contentType: "text/html",
			backend: "playwright",
		});
		const tool = createWebFetchBuiltin({
			allowedUrls: new Set(),
			approvedTools: new Set(["web_fetch"]),
		});

		const result = await tool.execute({ url }, fakeContext());
		expect(result).toEqual(expect.objectContaining({ resultText: expect.stringContaining("hi") }));
	});

	it("fetches an untrusted URL without a grant when the policy is always-allow", async () => {
		const url = "https://always.test/page";
		fetchPage.mockResolvedValue({
			url,
			title: "Always",
			content: "<p>hi</p>",
			contentType: "text/html",
			backend: "playwright",
		});
		const tool = createWebFetchBuiltin({
			allowedUrls: new Set(),
			toolApprovalPolicy: "always-allow",
		});

		const result = await tool.execute({ url }, fakeContext());
		expect(result).toEqual(expect.objectContaining({ resultText: expect.stringContaining("hi") }));
	});
});
