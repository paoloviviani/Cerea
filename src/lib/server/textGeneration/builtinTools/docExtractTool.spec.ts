import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const mocks = vi.hoisted(() => ({
	find: vi.fn(),
	listing: vi.fn(),
	extract: vi.fn(),
	download: vi.fn(),
	pageCount: vi.fn(),
	selects: vi.fn(),
	direct: vi.fn(),
	withholdStored: vi.fn(),
	withholdOutput: vi.fn(),
	blobs: [] as {
		key: string;
		value: { text?: string; pages?: Record<number, string>; total?: number; readerModel?: string };
	}[],
}));

vi.mock("./conversationFiles", async (importOriginal) => ({
	...(await importOriginal<typeof import("./conversationFiles")>()),
	findConversationFile: mocks.find,
	listFileVersions: mocks.listing,
	branchOfCall: async () => undefined,
}));
vi.mock("$lib/server/files/extractDocument", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/files/extractDocument")>()),
	extractDocument: mocks.extract,
	resolvedReader: async ({ readerModel }: { readerModel?: string | null }) =>
		readerModel?.trim() || "default-ocr",
	readerSelectsPages: mocks.selects,
	directOcrConfigured: mocks.direct,
}));
vi.mock("$lib/server/files/pdfPageCount", () => ({ pdfPageCount: mocks.pageCount }));
vi.mock("$lib/server/files/withholdRefusedImages", () => ({
	withholdStoredFile: mocks.withholdStored,
}));
vi.mock("$lib/server/execution/deliverables", () => ({
	withholdDeliverable: mocks.withholdOutput,
}));
vi.mock("$lib/server/files/downloadFile", () => ({ downloadFile: mocks.download }));
vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// The cache's own store, in memory (its real read/write is tested in extractCache.spec.ts): one entry per
// put, merged on read, keyed like the real one, so "no duplicate entries" is checkable.
vi.mock("$lib/server/files/extractCache", () => ({
	getCachedExtraction: async (c: string, sha: string, r: string) => {
		const entries = mocks.blobs.filter((b) => b.key.startsWith(`${c}|${sha}|${r}|`));
		if (entries.length === 0) return null;
		const merged: {
			pages: Map<number, string>;
			total?: number;
			text?: string;
			readerModel?: string;
		} = { pages: new Map() };
		for (const e of entries) {
			if (e.value.text !== undefined) merged.text = e.value.text;
			for (const [n, t] of Object.entries(e.value.pages ?? {})) merged.pages.set(Number(n), t);
			if (e.value.total) merged.total = e.value.total;
			merged.readerModel ??= e.value.readerModel;
		}
		return merged;
	},
	putCachedExtraction: async (
		c: string,
		sha: string,
		r: string,
		value: { text?: string; pages?: Record<number, string>; total?: number; readerModel?: string }
	) => {
		const range = value.text !== undefined ? "all" : Object.keys(value.pages ?? {}).join(",");
		const key = `${c}|${sha}|${r}|${range}`;
		if (!mocks.blobs.some((b) => b.key === key)) mocks.blobs.push({ key, value });
	},
}));

const {
	createDocExtractBuiltin,
	DOC_EXTRACT_TOOL_NAME,
	DOC_EXTRACT_MAX_PAGES,
	DOC_EXTRACT_TURN_PAGE_BUDGET,
	failureMessage,
} = await import("./docExtractTool");
const { getEnabledBuiltinTools } = await import("./index");
const { EXTERNAL_BUILTIN_TOOLS } = await import("../untrusted");

const conversationId = new ObjectId();
const ctx = () => ({ uuid: "u", toolCallId: "c", conversationId });
const PDF = Buffer.from("%PDF-1.4\n%fake\n");

function pdf(overrides: Record<string, unknown> = {}) {
	return {
		ok: true,
		name: "scan.pdf",
		bytes: PDF,
		sha256: "abc",
		mime: "application/pdf",
		origin: "output",
		version: 1,
		versionCount: 1,
		currentVersion: 1,
		tool: "web_fetch",
		...overrides,
	};
}

/** A remote OCR model's answer: one entry per requested page, with its real 0-based index. */
function perPage(pageNumbers: number[]) {
	return {
		ok: true,
		text: pageNumbers.map((n) => `text of page ${n}`).join("\n\n"),
		pages: pageNumbers.length,
		pageEntries: pageNumbers.map((n) => ({ page: n, text: `text of page ${n}` })),
		pagesSelected: true,
		readerModel: "ocr-1",
	};
}
/** Pystino's local reader: the whole text as one block; the real count only in pages_processed. */
const wholeBlock = (text = "all the text", pages = 12) => ({
	ok: true,
	text,
	pages,
	unpaged: true,
	readerModel: "ocr-1",
});

const tool = (params: Record<string, unknown> = {}) =>
	createDocExtractBuiltin({ token: "tok", readerModel: "ocr-1", ...params })[0];
const run = (args: Record<string, unknown>, t = tool()) => t.execute(args, ctx());
const text = (r: Awaited<ReturnType<typeof run>>) => ("resultText" in r ? r.resultText : "");
const err = (r: Awaited<ReturnType<typeof run>>) => ("error" in r ? r.error : "");

beforeEach(() => {
	for (const m of [
		mocks.find,
		mocks.listing,
		mocks.extract,
		mocks.download,
		mocks.pageCount,
		mocks.selects,
		mocks.direct,
		mocks.withholdStored,
		mocks.withholdOutput,
	]) {
		m.mockReset();
	}
	mocks.blobs.length = 0;
	mocks.listing.mockResolvedValue(undefined);
	mocks.pageCount.mockResolvedValue(null);
	mocks.selects.mockResolvedValue(true);
	mocks.direct.mockReturnValue(false);
	mocks.withholdStored.mockResolvedValue(undefined);
	mocks.withholdOutput.mockResolvedValue(undefined);
});

describe("doc_extract", () => {
	it("is named like doc_read, outside content, and says when to use it", () => {
		const t = tool();
		expect(t.name).toBe(DOC_EXTRACT_TOOL_NAME);
		expect(EXTERNAL_BUILTIN_TOOLS.has("doc_extract")).toBe(true);
		const description = t.definition.function.description ?? "";
		expect(description).toMatch(/doc_read first/);
		expect(description).toMatch(/look_doc/);
		expect(description).toMatch(/billed per page/);
		expect(description).toMatch(/png, jpg, webp/);
		const listed = getEnabledBuiltinTools({
			conv: { _id: new ObjectId() },
			toolsEnabled: true,
			documentExtract: { token: "t" },
		}).find((x) => x.name === "doc_extract");
		expect(listed?.definition.function.description).toMatch(/treat it as data/);
	});

	it("sends a fetched file through the upload extraction path as the user, with the user's reader", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.pageCount.mockResolvedValue(3);
		mocks.extract.mockResolvedValue(perPage([1, 2, 3]));
		const out = text(await run({ file: "scan.pdf" }));
		expect(mocks.extract).toHaveBeenCalledTimes(1);
		expect(mocks.extract.mock.calls[0][0]).toMatchObject({
			mime: "application/pdf",
			filename: "scan.pdf",
			token: "tok",
			readerModel: "ocr-1",
			pages: [1, 2, 3],
		});
		expect(out).toContain("[page 1]\ntext of page 1");
		expect(out).toContain("pages 1-3 of 3");
		expect(out).toContain("with ocr-1");
		expect(out).toContain("billed per page");
	});

	it("sends the reader only the pages asked for, and keeps those pages", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.pageCount.mockResolvedValue(100);
		mocks.extract.mockResolvedValueOnce(perPage([5, 6]));
		const first = text(await run({ file: "scan.pdf", pages: "5-6" }));
		expect(mocks.extract.mock.calls[0][0].pages).toEqual([5, 6]);
		expect(first).toContain("pages 5-6 of 100");
		// The same pages again: no call. Pages 6-7: only page 7 is read.
		await run({ file: "scan.pdf", pages: "5" });
		expect(mocks.extract).toHaveBeenCalledTimes(1);
		mocks.extract.mockResolvedValueOnce(perPage([7]));
		const more = text(await run({ file: "scan.pdf", pages: "6-7" }));
		expect(mocks.extract.mock.calls[1][0].pages).toEqual([7]);
		expect(more).toContain("text of page 6");
		expect(more).toContain("text of page 7");
		expect(mocks.blobs).toHaveLength(2);
	});

	it("never says page 1 of 1 for a reader that returns one block: it is the whole text, paged by offset", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.pageCount.mockResolvedValue(12);
		mocks.selects.mockResolvedValue(false);
		mocks.extract.mockResolvedValue(wholeBlock("a".repeat(70_000)));
		const first = text(await run({ file: "scan.pdf", pages: "3" }));
		expect(mocks.extract.mock.calls[0][0].pages).toBeUndefined();
		expect(first).toMatch(/whole text/);
		expect(first).toMatch(/no page boundaries/);
		expect(first).toMatch(/`pages` was ignored/);
		expect(first).not.toMatch(/page 1 of 1/);
		expect(first).toContain("offset 60000");
		const next = text(await run({ file: "scan.pdf", offset: 60_000 }));
		expect(mocks.extract).toHaveBeenCalledTimes(1);
		expect(next.length).toBeLessThan(11_000);
	});

	it("returns an uploaded file's text, never calling the reader, whatever `pages` says", async () => {
		mocks.find.mockResolvedValue(pdf({ origin: "attachment", tool: "attachment" }));
		mocks.listing.mockResolvedValue({
			name: "scan.pdf",
			versions: [],
			attachment: {
				file: {
					type: "hash",
					value: "abc",
					name: "scan.pdf",
					extracted: { value: "txt", pages: 2 },
					readerModel: "ocr-0",
				},
			},
		});
		mocks.download.mockResolvedValue({ value: Buffer.from("uploaded text").toString("base64") });
		const plain = text(await run({ file: "scan.pdf" }));
		const ranged = text(await run({ file: "scan.pdf", pages: "3-4" }));
		expect(mocks.extract).not.toHaveBeenCalled();
		expect(plain).toContain("uploaded text");
		expect(plain).toContain("when it was uploaded");
		expect(plain).toContain("ocr-0");
		expect(ranged).toContain("uploaded text");
		expect(ranged).toMatch(/`pages` was ignored/);
	});

	it("shares one extraction between concurrent calls on the same bytes", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.pageCount.mockResolvedValue(2);
		mocks.selects.mockResolvedValue(false);
		let release: (v: unknown) => void = () => undefined;
		mocks.extract.mockImplementation(() => new Promise((resolve) => (release = resolve)));
		const t = tool();
		const both = Promise.allSettled([run({ file: "scan.pdf" }, t), run({ file: "scan.pdf" }, t)]);
		await vi.waitFor(() => expect(mocks.extract).toHaveBeenCalledTimes(1));
		release(wholeBlock());
		const [a, b] = await both;
		expect(mocks.extract).toHaveBeenCalledTimes(1);
		expect(a.status === "fulfilled" && text(a.value)).toContain("all the text");
		expect(b.status === "fulfilled" && text(b.value)).toContain("all the text");
		expect(mocks.blobs).toHaveLength(1);
	});

	it("keys the cache on the bytes and the reader, and does not keep a fallback's text", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.extract.mockImplementation(async (o: { readerModel: string }) => ({
			...wholeBlock(),
			readerModel: o.readerModel,
		}));
		await run({ file: "scan.pdf" });
		await run({ file: "scan.pdf" }, tool({ readerModel: "ocr-2" }));
		mocks.find.mockResolvedValue(pdf({ sha256: "different" }));
		await run({ file: "scan.pdf" });
		expect(mocks.extract).toHaveBeenCalledTimes(3);
		expect(mocks.blobs).toHaveLength(3);
		mocks.extract.mockResolvedValue({ ...wholeBlock(), readerFallback: true });
		mocks.find.mockResolvedValue(pdf({ sha256: "other" }));
		await run({ file: "scan.pdf" });
		expect(mocks.blobs).toHaveLength(3);
	});

	it("does not keep or retry a failure", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.extract.mockResolvedValue({
			ok: false,
			kind: "unreachable",
			status: 502,
			reason: "Down.",
		});
		await run({ file: "scan.pdf" });
		expect(mocks.blobs).toHaveLength(0);
		expect(mocks.extract).toHaveBeenCalledTimes(1);
	});

	it("stops reading at the turn's page budget, before billing", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.pageCount.mockResolvedValue(500);
		let n = 0;
		mocks.extract.mockImplementation(async ({ pages }: { pages: number[] }) => ({
			...perPage(pages),
			pages: pages.length,
		}));
		const t = tool();
		// 5 calls of 40 pages = 200, the budget.
		for (let call = 0; call < 5; call += 1) {
			await run({ file: "scan.pdf", pages: `${call * 40 + 1}-${call * 40 + 40}` }, t);
			n += 1;
		}
		expect(n * DOC_EXTRACT_MAX_PAGES).toBe(DOC_EXTRACT_TURN_PAGE_BUDGET);
		const over = err(await run({ file: "scan.pdf", pages: "201-202" }, t));
		expect(over).toMatch(/page budget for this turn/);
		expect(over).toMatch(/ask whether to go on/);
		expect(mocks.extract).toHaveBeenCalledTimes(5);
		// What is already read is still served.
		expect(text(await run({ file: "scan.pdf", pages: "1-2" }, t))).toContain("no new call");
	});

	it("refuses an over-budget whole-file read before calling a reader that reads everything", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.pageCount.mockResolvedValue(300);
		mocks.selects.mockResolvedValue(false);
		const message = err(await run({ file: "scan.pdf" }));
		expect(message).toMatch(/page budget for this turn/);
		expect(mocks.extract).not.toHaveBeenCalled();
	});

	it("reserves the budget before the call, so concurrent reads of different files cannot all pass", async () => {
		mocks.pageCount.mockResolvedValue(150);
		mocks.selects.mockResolvedValue(false);
		let release: (v: unknown) => void = () => undefined;
		mocks.extract.mockImplementation(() => new Promise((resolve) => (release = resolve)));
		mocks.find.mockImplementation(async (_c: unknown, name: string) => pdf({ name, sha256: name }));
		const t = tool();
		const both = Promise.all([run({ file: "a.pdf" }, t), run({ file: "b.pdf" }, t)]);
		await vi.waitFor(() => expect(mocks.extract).toHaveBeenCalledTimes(1));
		release(wholeBlock("x", 150));
		const results = await both;
		expect(results.filter((r) => "error" in r)).toHaveLength(1);
		expect(err(results.find((r) => "error" in r) as never)).toMatch(/page budget for this turn/);
		expect(mocks.extract).toHaveBeenCalledTimes(1);
	});

	it("does not assume one page when the count is unknown: it estimates from the size", async () => {
		mocks.pageCount.mockResolvedValue(null);
		mocks.selects.mockResolvedValue(false);
		mocks.find.mockResolvedValue(
			pdf({ bytes: Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]) })
		);
		expect(err(await run({ file: "big.pdf" }))).toMatch(/page budget for this turn/);
		expect(mocks.extract).not.toHaveBeenCalled();
		mocks.find.mockResolvedValue(pdf());
		mocks.extract.mockResolvedValue(wholeBlock("small", 1));
		expect(text(await run({ file: "small.pdf" }))).toContain("small");
	});

	it("does not start a queued read once the turn is aborted", async () => {
		mocks.find.mockResolvedValue(pdf());
		const controller = new AbortController();
		controller.abort();
		const result = await tool().execute(
			{ file: "scan.pdf" },
			{ ...ctx(), abortSignal: controller.signal }
		);
		expect(err(result)).toMatch(/stopped/);
		expect(mocks.extract).not.toHaveBeenCalled();
	});

	it("caps the pages per call and refuses pages the file does not have", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.pageCount.mockResolvedValue(3);
		const tooMany = await run({ file: "scan.pdf", pages: `1-${DOC_EXTRACT_MAX_PAGES + 1}` });
		expect(err(tooMany)).toMatch(/Too many pages/);
		expect(err(tooMany)).not.toMatch(/look_doc/);
		const beyond = await run({ file: "scan.pdf", pages: "9" });
		expect(err(beyond)).toMatch(/has 3 pages; there is no page 9/);
		expect(mocks.extract).not.toHaveBeenCalled();
	});

	it("returns the first pages by default and says how to ask for the rest", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.pageCount.mockResolvedValue(45);
		mocks.extract.mockImplementation(async ({ pages }: { pages: number[] }) => perPage(pages));
		const out = text(await run({ file: "scan.pdf" }));
		expect(out).toContain(`pages 1-${DOC_EXTRACT_MAX_PAGES} of 45`);
		expect(out).toContain("5 more pages");
	});

	it("withholds the file on a privacy refusal, as an upload is, and says not to retry", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.extract.mockResolvedValue({
			ok: false,
			kind: "refused",
			status: 403,
			reason: "Withheld",
			withheld: { rule: "no-pii", pipeline: "eu" },
		});
		const message = err(await run({ file: "scan.pdf" }));
		expect(message).toMatch(/privacy rule \('no-pii', pipeline 'eu'\)/);
		expect(message).toMatch(/do not retry/);
		expect(mocks.blobs).toHaveLength(0);
		const withheld = { rule: "no-pii", pipeline: "eu" };
		expect(mocks.withholdStored).toHaveBeenCalledWith(conversationId, "abc", withheld);
		expect(mocks.withholdOutput).toHaveBeenCalledWith(conversationId, "abc", withheld);
	});

	it("words no text, unsupported and unreachable so the model can act", () => {
		const base = { ok: false as const, status: 422 };
		expect(failureMessage("a.pdf", { ...base, kind: "no-text", reason: "No text." })).toMatch(
			/Do not retry.*look_doc/
		);
		expect(failureMessage("a.pdf", { ...base, kind: "unsupported", reason: "PDFs only." })).toMatch(
			/cannot take.*Do not retry/
		);
		expect(failureMessage("a.pdf", { ...base, kind: "unreachable", reason: "Down." })).toMatch(
			/once more later/
		);
	});

	it("refuses a file past the upload size limit before calling the reader", async () => {
		mocks.find.mockResolvedValue(
			pdf({ bytes: Buffer.concat([PDF, Buffer.alloc(31 * 1024 * 1024)]) })
		);
		expect(err(await run({ file: "big.pdf" }))).toMatch(/too large.*30 MB/);
		expect(mocks.extract).not.toHaveBeenCalled();
	});

	it("refuses a file that is not a document, and passes a missing file's error on", async () => {
		mocks.find.mockResolvedValue(
			pdf({ name: "notes.txt", bytes: Buffer.from("just text"), mime: "text/plain" })
		);
		expect(err(await run({ file: "notes.txt" }))).toMatch(/not a document the reader takes/);
		mocks.find.mockResolvedValue({ ok: false, error: 'No file named "x" in this conversation.' });
		expect(err(await run({ file: "x" }))).toMatch(/No file named/);
		expect(mocks.extract).not.toHaveBeenCalled();
	});

	it("resolves versions like doc_read", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.extract.mockResolvedValue(wholeBlock());
		await run({ file: "scan.pdf", version: "previous" });
		expect(mocks.find).toHaveBeenCalledWith(
			conversationId,
			"scan.pdf",
			expect.objectContaining({ version: "previous", prefer: "output" })
		);
		expect(err(await run({ file: "scan.pdf", version: "x" }))).toMatch(/version/);
	});

	describe("images", () => {
		const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
		it("reads a png through the gateway reader, as one page", async () => {
			mocks.find.mockResolvedValue(pdf({ name: "photo.png", bytes: PNG, mime: "image/png" }));
			mocks.extract.mockResolvedValue({
				ok: true,
				text: "receipt",
				pages: 1,
				pageEntries: [{ page: 1, text: "receipt" }],
				readerModel: "ocr-1",
			});
			const out = text(await run({ file: "photo.png" }));
			expect(mocks.extract.mock.calls[0][0].mime).toBe("image/png");
			expect(out).toContain("receipt");
		});

		it("is neither offered nor accepted on a direct OCR endpoint, which reads PDFs only", async () => {
			mocks.direct.mockReturnValue(true);
			expect(tool().definition.function.description).not.toMatch(/png/);
			mocks.find.mockResolvedValue(pdf({ name: "photo.png", bytes: PNG, mime: "image/png" }));
			expect(err(await run({ file: "photo.png" }))).toMatch(/PDFs only.*view_image/);
			expect(mocks.extract).not.toHaveBeenCalled();
		});
	});
});
