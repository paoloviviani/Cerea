import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { BuiltinToolResult } from "./types";
import type { BuiltinToolContext } from "./types";

const fetchPage = vi.fn();

const extractDocument = vi.fn();

vi.mock("$lib/server/fetching", () => ({ fetchPage }));
vi.mock("$lib/server/files/extractDocument", () => ({ extractDocument }));

const {
	createWebFetchBuiltin,
	webFetchNeedsApproval,
	MAX_FETCHES_PER_TURN,
	MAX_FETCH_RESULT_CHARS,
	readablePageText,
	urlsInUserText,
	performFetch,
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

	it("chunks page text before it is added to the model context", async () => {
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
			expect.objectContaining({
				resultText: expect.stringContaining(
					`[Showing characters 0\u2013${MAX_FETCH_RESULT_CHARS} of ${MAX_FETCH_RESULT_CHARS + 1}. Call web_fetch again with the same url and offset=${MAX_FETCH_RESULT_CHARS} to read on.]`
				),
			})
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

	it("reads on with offset: successive chunks, the footer only while more remains", async () => {
		const url = "https://example.test/paged";
		const N = MAX_FETCH_RESULT_CHARS;
		const text = "a".repeat(N) + "b".repeat(N) + "c".repeat(10);
		fetchPage.mockResolvedValue({
			url,
			title: "Paged",
			content: text,
			contentType: "text/plain",
			backend: "direct",
		});
		const tool = createWebFetchBuiltin({ allowedUrls: new Set([url]) });
		const body = (r: BuiltinToolResult) => {
			if (!("resultText" in r)) throw new Error("expected text");
			return r.resultText.split("\n\n").slice(1).join("\n\n");
		};
		const first = await tool.execute({ url }, {} as never);
		expect(body(first)).toBe(
			"a".repeat(N) +
				`\n\n[Showing characters 0\u2013${N} of ${2 * N + 10}. Call web_fetch again with the same url and offset=${N} to read on.]`
		);
		const second = await tool.execute({ url, offset: N }, {} as never);
		expect(body(second)).toBe(
			"b".repeat(N) +
				`\n\n[Showing characters ${N}\u2013${2 * N} of ${2 * N + 10}. Call web_fetch again with the same url and offset=${2 * N} to read on.]`
		);
		const last = await tool.execute({ url, offset: 2 * N }, {} as never);
		expect(body(last)).toBe("c".repeat(10));
		expect(await tool.execute({ url, offset: 5 * N }, {} as never)).toEqual(
			expect.objectContaining({ error: expect.stringContaining("past the end") })
		);
		expect(await tool.execute({ url, offset: -1 }, {} as never)).toEqual(
			expect.objectContaining({ error: expect.stringContaining("non-negative integer") })
		);
	});

	it("does not fetch again, or count against the turn limit, when reading on", async () => {
		const url = "https://example.test/cached";
		fetchPage.mockResolvedValue({
			url,
			title: null,
			content: "x".repeat(MAX_FETCH_RESULT_CHARS * 2),
			contentType: "text/plain",
			backend: "direct",
		});
		const tool = createWebFetchBuiltin({ allowedUrls: new Set([url]) });
		for (let i = 0; i < MAX_FETCHES_PER_TURN + 5; i++) {
			const r = await tool.execute(
				{ url, offset: i % 2 ? MAX_FETCH_RESULT_CHARS : 0 },
				{} as never
			);
			expect(r).toEqual({ resultText: expect.any(String) });
		}
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it("extracts a PDF with the document reader, as the turn's user, and returns its text", async () => {
		const url = "https://arxiv.example/pdf/1";
		const bytes = new TextEncoder().encode("%PDF-1.7 binary").buffer;
		fetchPage.mockResolvedValue({
			url,
			title: "1",
			content: "",
			contentType: "application/pdf",
			backend: "direct",
			document: { bytes, mime: "application/pdf", filename: "1.pdf" },
		});
		extractDocument.mockResolvedValue({ ok: true, text: "# Paper\n\nFull text.", pages: 3 });
		const result = await createWebFetchBuiltin({
			allowedUrls: new Set([url]),
			token: "user-token",
		}).execute({ url }, {} as never);
		expect(extractDocument).toHaveBeenCalledWith(
			expect.objectContaining({ bytes, mime: "application/pdf", token: "user-token" })
		);
		expect(result).toEqual({
			resultText: `Title: 1\nURL: ${url}\n\n# Paper\n\nFull text.`,
		});
	});

	it("extracts a document once however many chunks are read", async () => {
		const url = "https://arxiv.example/pdf/2";
		fetchPage.mockResolvedValue({
			url,
			title: null,
			content: "",
			contentType: "application/pdf",
			backend: "direct",
			document: { bytes: new ArrayBuffer(8), mime: "application/pdf", filename: "2.pdf" },
		});
		extractDocument.mockResolvedValue({
			ok: true,
			text: "p".repeat(MAX_FETCH_RESULT_CHARS + 5),
			pages: 9,
		});
		const tool = createWebFetchBuiltin({ allowedUrls: new Set([url]), token: "t" });
		await tool.execute({ url }, {} as never);
		await tool.execute({ url, offset: MAX_FETCH_RESULT_CHARS }, {} as never);
		expect(extractDocument).toHaveBeenCalledTimes(1);
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it("reports the extractor's own reason when a PDF cannot be read, and never the bytes", async () => {
		const url = "https://arxiv.example/pdf/3";
		fetchPage.mockResolvedValue({
			url,
			title: null,
			content: "",
			contentType: "application/pdf",
			backend: "direct",
			document: { bytes: new ArrayBuffer(8), mime: "application/pdf", filename: "3.pdf" },
		});
		extractDocument.mockResolvedValue({
			ok: false,
			kind: "no-reader",
			status: 503,
			reason: "No reader is configured.",
		});
		const result = await createWebFetchBuiltin({ allowedUrls: new Set([url]), token: "t" }).execute(
			{ url },
			{} as never
		);
		expect(result).toEqual({ error: "This PDF could not be read: No reader is configured." });
	});

	it("the approval-resume path (performFetch) formats exactly like the tool call", async () => {
		const url = "https://example.test/same";
		const content = "w".repeat(MAX_FETCH_RESULT_CHARS + 100);
		fetchPage.mockResolvedValue({
			url,
			title: "Same",
			content,
			contentType: "text/plain",
			backend: "direct",
		});
		const viaTool = await createWebFetchBuiltin({ allowedUrls: new Set([url]) }).execute(
			{ url, offset: 50 },
			{} as never
		);
		const viaResume = await performFetch(url, { offset: 50 });
		expect(viaResume.result).toEqual(viaTool);
	});

	it("takes only HTTPS URLs from user text as initial fetch targets", () => {
		expect(urlsInUserText("Read https://example.test/a and http://unsafe.test/b")).toEqual([
			"https://example.test/a",
		]);
	});

	it("keeps the article and drops navigation chrome", () => {
		expect(
			readablePageText(
				"<body><nav>Home Docs Login</nav><article><h1>Title</h1><p>Body text</p></article><footer>Legal</footer></body>"
			)
		).toBe("Title Body text");
		expect(readablePageText("<body><nav>Menu</nav><p>Plain</p><footer>Legal</footer></body>")).toBe(
			"Plain"
		);
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
