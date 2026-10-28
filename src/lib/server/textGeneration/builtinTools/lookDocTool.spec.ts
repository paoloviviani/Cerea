import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { sourceSha256 } from "$lib/server/office/previewStore";
import type { DocumentCapabilities } from "$lib/server/documents/client";

// The two services are the things replaced: Gotenberg (the office -> PDF conversion) and the document
// service's /v1/render. The preview store, its bucket and Mongo are real, so "a file already previewed costs
// nothing" is the store's own behaviour.
const gotenberg = vi.hoisted(() => ({ convert: vi.fn(), on: true }));
vi.mock("$lib/server/office/gotenberg", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/office/gotenberg")>();
	return {
		...actual,
		convertOfficeToPdf: gotenberg.convert,
		isGotenbergEnabled: () => gotenberg.on,
	};
});

const service = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("$lib/server/documents/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/documents/client")>()),
	renderPdf: service.render,
}));

const files = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("./conversationFiles", () => ({
	findConversationFile: files.find,
	bareName: (s: string) => s,
}));

vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createLookDocBuiltins, parsePages, LOOK_DOC_MAX_PAGES, MAX_LOOK_CALLS_PER_TURN } =
	await import("./lookDocTool");
const { slidesTouched } = await import("./documentTools");
const { DocumentsError } = await import("$lib/server/documents/client");
const { ConversionError } = await import("$lib/server/office/gotenberg");
const { previewFilename } = await import("$lib/server/office/previewStore");

const CAPS: DocumentCapabilities = {
	formats: {},
	render: { formats: ["pdf"], image_types: ["png", "jpeg"] },
	limits: { max_render_pages: 6, max_render_px: 2000 },
};

function rendered(pages: number[], count: number) {
	return {
		page_count: count,
		pages: pages.map((page) => ({
			page,
			width: 1200,
			height: 675,
			format: "png",
			content_type: "image/png",
			base64: Buffer.from(`png-${page}`).toString("base64"),
		})),
	};
}

const PDF = Buffer.from("%PDF-1.7\nlook");
let cleanup: string[] = [];
const conversationId = new ObjectId();

function pptx(label = "deck"): {
	ok: true;
	name: string;
	bytes: Buffer;
	sha256: string;
	origin: "output";
} {
	const bytes = Buffer.from(`PK ${label} ${new ObjectId()}`);
	const sha256 = sourceSha256(bytes);
	cleanup.push(sha256);
	return { ok: true, name: "deck.pptx", bytes, sha256, origin: "output" };
}

function tool(
	turn?: Parameters<typeof createLookDocBuiltins>[1],
	caps: DocumentCapabilities | null = CAPS
) {
	const [look] = createLookDocBuiltins(caps, turn);
	return look;
}
const ctx = () => ({ uuid: "u", toolCallId: "c", conversationId });

beforeAll(async () => {
	await ready;
});

beforeEach(() => {
	gotenberg.on = true;
	gotenberg.convert.mockReset();
	gotenberg.convert.mockResolvedValue(PDF);
	service.render.mockReset();
	service.render.mockImplementation(async (_pdf: Buffer, request: { pages?: number[] }) =>
		rendered(request.pages ?? [1, 2, 3, 4, 5, 6], 12)
	);
	files.find.mockReset();
});

afterEach(async () => {
	for (const sha of cleanup) {
		const rows = await collections.bucketFiles.find({ filename: previewFilename(sha) }).toArray();
		await Promise.all(rows.map((row) => collections.bucket.delete(row._id)));
	}
	cleanup = [];
});

describe("parsePages", () => {
	it("reads numbers, ranges and lists of them", () => {
		expect(parsePages(3)).toEqual({ ok: true, pages: [3] });
		expect(parsePages("2-4")).toEqual({ ok: true, pages: [2, 3, 4] });
		expect(parsePages("1, 3-4")).toEqual({ ok: true, pages: [1, 3, 4] });
		expect(parsePages([5, "1-2", 2])).toEqual({ ok: true, pages: [5, 1, 2] });
		expect(parsePages("2 to 3")).toEqual({ ok: true, pages: [2, 3] });
	});

	it("means the default when nothing is given", () => {
		expect(parsePages(undefined)).toEqual({ ok: true, pages: undefined });
		expect(parsePages("")).toEqual({ ok: true, pages: undefined });
		expect(parsePages([])).toEqual({ ok: true, pages: undefined });
	});

	it("refuses more than the cap, saying how many were asked for and the cap", () => {
		expect(parsePages("1-6")).toMatchObject({ ok: true });
		const seven = parsePages("1-7");
		expect(seven).toMatchObject({ ok: false });
		expect(seven.ok === false && seven.error).toMatch(/at most 6 per call.*7 or more/);
		// a huge range is refused by arithmetic, not by building a list of it
		expect(parsePages("1-999999")).toMatchObject({ ok: false });
		expect(parsePages([1, 2, 3, "4-9"])).toMatchObject({ ok: false });
	});

	it("refuses what is not a page, with an example", () => {
		for (const input of ["first", "1-", "-3", "2.5", { a: 1 }, ["x"], "3-1", 0, "0-2", -1]) {
			const parsed = parsePages(input);
			expect(parsed.ok, JSON.stringify(input)).toBe(false);
		}
		const bad = parsePages("first");
		expect(bad.ok === false && bad.error).toContain("1-based page numbers or ranges");
		const back = parsePages("5-3");
		expect(back.ok === false && back.error).toContain('"3-5"');
	});

	it("honours a smaller cap", () => {
		expect(parsePages("1-3", 2)).toMatchObject({ ok: false });
	});
});

describe("look_doc is offered only where the service draws pages", () => {
	it("is absent without a service, without the render capability, or with no PDF rendering", () => {
		expect(createLookDocBuiltins(null)).toEqual([]);
		expect(createLookDocBuiltins(undefined)).toEqual([]);
		expect(createLookDocBuiltins({ formats: {} })).toEqual([]);
		expect(
			createLookDocBuiltins({ formats: {}, render: { formats: [], image_types: [] } })
		).toEqual([]);
		expect(createLookDocBuiltins(CAPS)).toHaveLength(1);
	});

	it("says what it costs and that Office files are drawn by LibreOffice", () => {
		const text = tool().definition.function.description ?? "";
		expect(text).toContain(`At most ${LOOK_DOC_MAX_PAGES} pages per call`);
		expect(text).toMatch(/1,100 tokens.*1,900/);
		expect(text).toMatch(/PNG or JPEG, whichever is smaller/);
		expect(text).toMatch(/1,200 px on the longest side, pages about 1,000 px wide/);
		expect(text).toContain("LibreOffice");
		expect(text).toMatch(/not for pixel checks/);
		expect(text.length).toBeLessThan(1_800);
	});

	it("without Gotenberg offers PDFs only and says so", () => {
		gotenberg.on = false;
		const text = tool().definition.function.description ?? "";
		expect(text).toContain("PDF file");
		expect(text).toContain("cannot be drawn on this deployment");
		expect(text).not.toContain("LibreOffice");
	});
});

describe("look_doc through the preview cache", () => {
	it("converts a deck once for two calls, and draws each time", async () => {
		const file = pptx();
		files.find.mockResolvedValue(file);
		const look = tool();

		const first = await look.execute({ file: "deck.pptx", pages: "2-3" }, ctx());
		const second = await look.execute({ file: "deck.pptx", pages: [5] }, ctx());

		expect(gotenberg.convert).toHaveBeenCalledTimes(1);
		expect(service.render).toHaveBeenCalledTimes(2);
		// the PDF Gotenberg made is what the service was given, with a slide-sized request
		expect(service.render.mock.calls[0][0].equals(PDF)).toBe(true);
		expect(service.render.mock.calls[0][1]).toEqual({ pages: [2, 3], max_side_px: 1200 });
		expect(service.render.mock.calls[1][1]).toEqual({ pages: [5], max_side_px: 1200 });
		expect(first).toMatchObject({ resultText: expect.stringContaining("deck.pptx has 12 slides") });
		expect(second).toMatchObject({ images: [{ label: "deck.pptx, slide 5 of 12" }] });
	});

	it("does not convert a file the chat already previewed", async () => {
		const file = pptx();
		files.find.mockResolvedValue(file);
		const { getOrCreatePreview, previewOwner } = await import("$lib/server/office/previewStore");
		await getOrCreatePreview({
			bytes: file.bytes,
			name: file.name,
			owner: previewOwner("out", conversationId.toString(), file.sha256),
		});
		expect(gotenberg.convert).toHaveBeenCalledTimes(1);

		await tool().execute({ file: "deck.pptx" }, ctx());
		expect(gotenberg.convert).toHaveBeenCalledTimes(1);
	});

	it("sends a PDF as it is, and sizes pages by their width", async () => {
		files.find.mockResolvedValue({
			ok: true,
			name: "form.pdf",
			bytes: PDF,
			sha256: "a".repeat(64),
			origin: "attachment",
		});
		const out = await tool().execute({ file: "form.pdf", pages: 1 }, ctx());
		expect(gotenberg.convert).not.toHaveBeenCalled();
		expect(service.render.mock.calls[0][1]).toEqual({ pages: [1], width_px: 1000 });
		expect(out).toMatchObject({ resultText: expect.stringContaining("form.pdf has 12 pages") });
		expect(out).not.toMatchObject({ resultText: expect.stringContaining("LibreOffice") });
	});

	it("returns the images with a label each, how many pages exist, and how to ask for others", async () => {
		files.find.mockResolvedValue(pptx());
		const out = await tool().execute({ file: "deck.pptx" }, ctx());
		if (!("images" in out) || !out.images) throw new Error("no images");
		expect(out.images).toHaveLength(6);
		expect(out.images[0]).toEqual({
			mime: "image/png",
			base64: Buffer.from("png-1").toString("base64"),
			label: "deck.pptx, slide 1 of 12",
		});
		expect(out.resultText).toMatch(/has 12 slides/);
		expect(out.resultText).toMatch(/Showing slides 1, 2, 3, 4, 5, 6 as PNG images/);
		expect(out.resultText).toMatch(/6 more not shown: ask for them with `pages`/);
		expect(out.resultText).toContain("LibreOffice");
	});

	it("shows the slides the last deck edit touched when no pages are given", async () => {
		files.find.mockResolvedValue(pptx());
		const turn = { touchedSlides: new Map([["deck.pptx", [4, 9]]]) };
		await tool(turn).execute({ file: "deck.pptx" }, ctx());
		expect(service.render.mock.calls[0][1]).toEqual({ pages: [4, 9], max_side_px: 1200 });
		// explicit pages win
		await tool(turn).execute({ file: "deck.pptx", pages: 1 }, ctx());
		expect(service.render.mock.calls[1][1]).toEqual({ pages: [1], max_side_px: 1200 });
	});

	it("falls back to the first slides when the touched ones no longer exist", async () => {
		files.find.mockResolvedValue(pptx());
		service.render.mockReset();
		service.render
			.mockRejectedValueOnce(
				new DocumentsError("rejected", "the document has 3 pages; page 9 does not exist")
			)
			.mockResolvedValueOnce(rendered([1, 2, 3], 3));
		const turn = { touchedSlides: new Map([["deck.pptx", [9]]]) };
		const out = await tool(turn).execute({ file: "deck.pptx" }, ctx());
		expect(service.render.mock.calls[1][1]).toEqual({ max_side_px: 1200 });
		expect(out).toMatchObject({ images: expect.any(Array) });
	});
});

describe("look_doc errors are plain", () => {
	it("an unknown file", async () => {
		files.find.mockResolvedValue({
			ok: false,
			error: 'No file named "x.pptx" in this conversation.',
		});
		expect(await tool().execute({ file: "x.pptx" }, ctx())).toEqual({
			error: 'No file named "x.pptx" in this conversation.',
		});
		expect(await tool().execute({}, ctx())).toMatchObject({
			error: expect.stringContaining("Give `file`"),
		});
	});

	it("a format that cannot be drawn", async () => {
		files.find.mockResolvedValue({
			ok: true,
			name: "data.csv",
			bytes: Buffer.from("a,b"),
			sha256: "b".repeat(64),
			origin: "attachment",
		});
		const out = await tool().execute({ file: "data.csv" }, ctx());
		expect(out).toMatchObject({
			error: expect.stringMatching(/shows Word, Excel, PowerPoint and PDF files, not \.csv/),
		});
		expect(service.render).not.toHaveBeenCalled();
	});

	it("an Office file when there is no converter", async () => {
		gotenberg.on = false;
		files.find.mockResolvedValue(pptx());
		const out = await tool().execute({ file: "deck.pptx" }, ctx());
		expect(out).toMatchObject({
			error: expect.stringContaining("only PDF files can be looked at"),
		});
		expect(gotenberg.convert).not.toHaveBeenCalled();
	});

	it("a failed conversion", async () => {
		files.find.mockResolvedValue(pptx());
		gotenberg.convert.mockRejectedValue(
			new ConversionError("failed", "LibreOffice could not open the file.")
		);
		const out = await tool().execute({ file: "deck.pptx" }, ctx());
		expect(out).toEqual({
			error: '"deck.pptx" could not be converted to look at: LibreOffice could not open the file.',
		});
		expect(service.render).not.toHaveBeenCalled();
	});

	it("an encrypted PDF, as the service words it", async () => {
		files.find.mockResolvedValue({
			ok: true,
			name: "locked.pdf",
			bytes: PDF,
			sha256: "c".repeat(64),
			origin: "attachment",
		});
		service.render.mockRejectedValue(
			new DocumentsError(
				"rejected",
				"the PDF is encrypted (password-protected), which this tool cannot open; remove the protection first"
			)
		);
		const out = await tool().execute({ file: "locked.pdf" }, ctx());
		expect(out).toMatchObject({ error: expect.stringContaining("encrypted") });
	});

	it("too many pages, before anything is converted", async () => {
		files.find.mockResolvedValue(pptx());
		const out = await tool().execute({ file: "deck.pptx", pages: "1-8" }, ctx());
		expect(out).toMatchObject({ error: expect.stringMatching(/at most 6 per call/) });
		expect(gotenberg.convert).not.toHaveBeenCalled();
		expect(service.render).not.toHaveBeenCalled();
	});

	it("a page that does not exist, and a service that is down", async () => {
		files.find.mockResolvedValue(pptx());
		service.render.mockRejectedValueOnce(
			new DocumentsError("rejected", "the document has 12 pages; page 40 does not exist")
		);
		expect(await tool().execute({ file: "deck.pptx", pages: 40 }, ctx())).toEqual({
			error: "the document has 12 pages; page 40 does not exist",
		});
		service.render.mockRejectedValueOnce(
			new DocumentsError("unavailable", "The document service is not reachable right now.")
		);
		expect(await tool().execute({ file: "deck.pptx", pages: 1 }, ctx())).toEqual({
			error: "The document service is not reachable right now.",
		});
	});

	it("stops after the per-turn limit", async () => {
		files.find.mockResolvedValue(pptx());
		const look = tool();
		for (let i = 0; i < MAX_LOOK_CALLS_PER_TURN; i += 1) {
			expect(await look.execute({ file: "deck.pptx", pages: 1 }, ctx())).toHaveProperty("images");
		}
		expect(await look.execute({ file: "deck.pptx", pages: 1 }, ctx())).toMatchObject({
			error: expect.stringContaining("limit"),
		});
	});
});

describe("slidesTouched", () => {
	it("reads the slides an edit's operations report, sorted and without repeats", () => {
		expect(
			slidesTouched([
				{ index: 0, op: "set_placeholder_text", result: { slide: 3, paragraphs: 2 } },
				{ index: 1, op: "set_notes", result: { slide: 3 } },
				{ index: 2, op: "duplicate_slide", result: { slide: 1, new_slide_position: 2 } },
				{ index: 3, op: "replace_text", result: { replaced: 2 } },
				{ index: 4, op: "delete_slide", result: { deleted: 7 } },
			])
		).toEqual([1, 2, 3]);
		expect(slidesTouched([])).toEqual([]);
	});
});
