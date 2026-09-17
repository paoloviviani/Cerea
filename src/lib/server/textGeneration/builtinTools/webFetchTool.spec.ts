import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { BuiltinToolResult } from "./types";
import type { BuiltinToolContext } from "./types";

const fetchPage = vi.fn();
const openFetchApprovalPrompt = vi.fn();
const verifyUrlBySearch = vi.fn();
const turnAwaitingInput = vi.fn();

vi.mock("$lib/server/fetching", () => ({ fetchPage }));
vi.mock("./fetchApproval", () => ({
	openFetchApprovalPrompt,
	FETCH_APPROVAL_SCOPE_FIELD: "scope",
	FETCH_APPROVAL_ONCE: "once",
	FETCH_APPROVAL_CONVERSATION: "conversation",
}));
vi.mock("./fetchVerification", () => ({ verifyUrlBySearch }));
vi.mock("$lib/server/generation/turnState", () => ({ turnAwaitingInput }));

const {
	createWebFetchBuiltin,
	MAX_FETCHES_PER_TURN,
	MAX_FETCH_RESULT_CHARS,
	readablePageText,
	urlsInUserText,
} = await import("./webFetchTool");

describe("web_fetch builtin", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		turnAwaitingInput.mockResolvedValue({ type: "turn-state" });
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

describe("web_fetch: ask-per-domain policy", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		turnAwaitingInput.mockResolvedValue({ type: "turn-state" });
	});

	it("parks the turn on an unapproved domain instead of refusing outright", async () => {
		openFetchApprovalPrompt.mockResolvedValue({ opened: true });
		const ctx = fakeContext();
		const tool = createWebFetchBuiltin({ allowedUrls: new Set(), policy: "ask-domain" });

		const result = await tool.execute({ url: "https://unseen.test/page" }, ctx);

		expect(result).toEqual({ awaitingInput: true });
		expect(openFetchApprovalPrompt).toHaveBeenCalledWith(
			expect.objectContaining({ url: "https://unseen.test/page", toolCallId: "call-1" })
		);
		expect(turnAwaitingInput).toHaveBeenCalledWith(
			expect.objectContaining({ conversationId: ctx.conversationId, messageId: "message-1" })
		);
		expect(ctx.elicitationSink?.emit).toHaveBeenCalledWith({ type: "turn-state" });
		expect(fetchPage).not.toHaveBeenCalled();
	});

	it("fetches without prompting once the domain is approved for the conversation", async () => {
		const url = "https://known.test/page";
		fetchPage.mockResolvedValue({
			url,
			title: "Known",
			content: "<p>hi</p>",
			contentType: "text/html",
			backend: "playwright",
		});
		const tool = createWebFetchBuiltin({
			allowedUrls: new Set(),
			policy: "ask-domain",
			approvedDomains: new Set(["known.test"]),
		});

		const result = await tool.execute({ url }, fakeContext());

		expect(result).toEqual(expect.objectContaining({ resultText: expect.stringContaining("hi") }));
		expect(openFetchApprovalPrompt).not.toHaveBeenCalled();
	});

	it("refuses without parking when there is no chat to ask", async () => {
		const tool = createWebFetchBuiltin({ allowedUrls: new Set(), policy: "ask-domain" });
		const result = await tool.execute(
			{ url: "https://unseen.test/page" },
			fakeContext({ elicitationSink: undefined })
		);
		expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining("no chat") }));
		expect(openFetchApprovalPrompt).not.toHaveBeenCalled();
	});
});

describe("web_fetch: auto-fetch with verification policy", () => {
	beforeEach(() => vi.resetAllMocks());

	it("fetches once a fresh search verifies the URL, never on the model's say-so alone", async () => {
		verifyUrlBySearch.mockResolvedValue({ matched: true });
		const url = "https://unseen.test/page";
		fetchPage.mockResolvedValue({
			url,
			title: "Found",
			content: "<p>content</p>",
			contentType: "text/html",
			backend: "playwright",
		});
		const allowedUrls = new Set<string>();
		const tool = createWebFetchBuiltin({
			allowedUrls,
			policy: "auto-verified",
			verificationToken: "token",
		});

		const result = await tool.execute({ url }, fakeContext());

		expect(verifyUrlBySearch).toHaveBeenCalledWith({ url, token: "token" });
		expect(result).toEqual(
			expect.objectContaining({ resultText: expect.stringContaining("content") })
		);
		expect(allowedUrls.has(url)).toBe(true);
	});

	it("fails closed with the harness's evidence when verification finds no match", async () => {
		verifyUrlBySearch.mockResolvedValue({
			matched: false,
			evidence: "Searched for: https://unseen.test/page\nResults:\n(no results)",
		});
		const tool = createWebFetchBuiltin({
			allowedUrls: new Set(),
			policy: "auto-verified",
			verificationToken: "token",
		});

		const result = await tool.execute({ url: "https://unseen.test/page" }, fakeContext());

		expect(result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("Searched for:") })
		);
		expect(fetchPage).not.toHaveBeenCalled();
	});

	it("refuses without searching when there is no verification credential", async () => {
		const tool = createWebFetchBuiltin({ allowedUrls: new Set(), policy: "auto-verified" });
		const result = await tool.execute({ url: "https://unseen.test/page" }, fakeContext());
		expect(result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("no search credential") })
		);
		expect(verifyUrlBySearch).not.toHaveBeenCalled();
	});
});
