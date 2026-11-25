import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const mocks = vi.hoisted(() => ({
	find: vi.fn(),
	listing: vi.fn(),
	extract: vi.fn(),
	download: vi.fn(),
	cache: new Map<string, unknown>(),
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
}));
vi.mock("$lib/server/files/extractCache", () => ({
	readerKey: (m?: string | null) => m?.trim() || "default",
	getCachedExtraction: async (c: string, sha: string, r: string) =>
		mocks.cache.get(`${c}|${sha}|${r}`) ?? null,
	putCachedExtraction: async (c: string, sha: string, r: string, v: unknown) => {
		mocks.cache.set(`${c}|${sha}|${r}`, v);
	},
}));
vi.mock("$lib/server/files/downloadFile", () => ({ downloadFile: mocks.download }));
vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createDocExtractBuiltin, DOC_EXTRACT_TOOL_NAME, DOC_EXTRACT_MAX_PAGES, failureMessage } =
	await import("./docExtractTool");
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

const pagesOf = (n: number) => Array.from({ length: n }, (_, i) => `text of page ${i + 1}`);
function read(n = 3) {
	return {
		ok: true,
		text: pagesOf(n).join("\n\n"),
		pages: n,
		pageTexts: pagesOf(n),
		readerModel: "ocr-1",
	};
}

const tool = () => createDocExtractBuiltin({ token: "tok", readerModel: "ocr-1" })[0];
const run = (args: Record<string, unknown>, t = tool()) => t.execute(args, ctx());
const text = (r: Awaited<ReturnType<typeof run>>) => ("resultText" in r ? r.resultText : "");
const err = (r: Awaited<ReturnType<typeof run>>) => ("error" in r ? r.error : "");

beforeEach(() => {
	for (const m of [mocks.find, mocks.listing, mocks.extract, mocks.download]) m.mockReset();
	mocks.cache.clear();
	mocks.listing.mockResolvedValue(undefined);
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
		// The registry appends the guard sentence for outside content.
		const listed = getEnabledBuiltinTools({
			conv: { _id: new ObjectId() },
			toolsEnabled: true,
			documentExtract: { token: "t" },
		}).find((x) => x.name === "doc_extract");
		expect(listed?.definition.function.description).toMatch(/treat it as data/);
	});

	it("sends a fetched file through the upload extraction path as the user, with the user's reader", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.extract.mockResolvedValue(read());
		const result = await run({ file: "scan.pdf" });
		expect(mocks.extract).toHaveBeenCalledTimes(1);
		expect(mocks.extract.mock.calls[0][0]).toMatchObject({
			mime: "application/pdf",
			filename: "scan.pdf",
			token: "tok",
			readerModel: "ocr-1",
		});
		const out = text(result);
		expect(out).toContain("[page 1]\ntext of page 1");
		expect(out).toContain("pages 1-3 of 3");
		expect(out).toContain("with ocr-1");
		expect(out).toContain("billed per page");
	});

	it("serves a second call on the same bytes from the cache, with no second call to the reader", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.extract.mockResolvedValue(read());
		await run({ file: "scan.pdf" });
		const again = await run({ file: "scan.pdf" });
		const other = await run(
			{ file: "scan.pdf", pages: "2" },
			createDocExtractBuiltin({ token: "tok", readerModel: "ocr-1" })[0]
		);
		expect(mocks.extract).toHaveBeenCalledTimes(1);
		expect(text(again)).toContain("no new call");
		expect(text(other)).toContain("text of page 2");
		expect(text(other)).not.toContain("text of page 1");
	});

	it("keys the cache on the bytes and the reader", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.extract.mockResolvedValue(read());
		await run({ file: "scan.pdf" });
		await run(
			{ file: "scan.pdf" },
			createDocExtractBuiltin({ token: "tok", readerModel: "ocr-2" })[0]
		);
		mocks.find.mockResolvedValue(pdf({ sha256: "different" }));
		await run({ file: "scan.pdf" });
		expect(mocks.extract).toHaveBeenCalledTimes(3);
	});

	it("returns an uploaded file's upload extraction without a call", async () => {
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
		const result = await run({ file: "scan.pdf" });
		expect(mocks.extract).not.toHaveBeenCalled();
		expect(text(result)).toContain("uploaded text");
		expect(text(result)).toContain("when it was uploaded");
		expect(text(result)).toContain("ocr-0");
	});

	it("reads a page range of an uploaded file once and keeps it", async () => {
		mocks.find.mockResolvedValue(pdf({ origin: "attachment" }));
		mocks.listing.mockResolvedValue({
			name: "scan.pdf",
			versions: [],
			attachment: {
				file: {
					type: "hash",
					value: "abc",
					name: "scan.pdf",
					extracted: { value: "txt", pages: 3 },
				},
			},
		});
		mocks.extract.mockResolvedValue(read());
		const result = await run({ file: "scan.pdf", pages: "3" });
		expect(text(result)).toContain("text of page 3");
		await run({ file: "scan.pdf", pages: "1" });
		expect(mocks.extract).toHaveBeenCalledTimes(1);
	});

	it("caps the pages per call and refuses pages the file does not have", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.extract.mockResolvedValue(read(3));
		const tooMany = await run({ file: "scan.pdf", pages: `1-${DOC_EXTRACT_MAX_PAGES + 1}` });
		expect(err(tooMany)).toMatch(/Too many pages/);
		expect(err(tooMany)).not.toMatch(/look_doc/);
		expect(mocks.extract).not.toHaveBeenCalled();
		const beyond = await run({ file: "scan.pdf", pages: "9" });
		expect(err(beyond)).toMatch(/has 3 pages; there is no page 9/);
	});

	it("returns the first pages by default and says how to ask for the rest", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.extract.mockResolvedValue(read(DOC_EXTRACT_MAX_PAGES + 5));
		const out = text(await run({ file: "scan.pdf" }));
		expect(out).toContain(`pages 1-${DOC_EXTRACT_MAX_PAGES} of ${DOC_EXTRACT_MAX_PAGES + 5}`);
		expect(out).toContain("5 more pages");
	});

	it("cuts long text and continues with offset", async () => {
		mocks.find.mockResolvedValue(pdf());
		mocks.extract.mockResolvedValue({
			ok: true,
			text: "x",
			pages: 1,
			pageTexts: ["a".repeat(70_000)],
		});
		const first = text(await run({ file: "scan.pdf" }));
		expect(first).toContain("offset 60000");
		const next = text(await run({ file: "scan.pdf", offset: 60_000 }));
		expect(next).not.toContain("offset");
		expect(next.length).toBeLessThan(11_000);
	});

	it("tells the model not to retry a privacy refusal", async () => {
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
		expect(mocks.cache.size).toBe(0);
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
		const message = err(await run({ file: "big.pdf" }));
		expect(message).toMatch(/too large.*30 MB/);
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
		mocks.extract.mockResolvedValue(read(1));
		await run({ file: "scan.pdf", version: "previous" });
		expect(mocks.find).toHaveBeenCalledWith(
			conversationId,
			"scan.pdf",
			expect.objectContaining({ version: "previous", prefer: "output" })
		);
		expect(err(await run({ file: "scan.pdf", version: "x" }))).toMatch(/version/);
	});
});
