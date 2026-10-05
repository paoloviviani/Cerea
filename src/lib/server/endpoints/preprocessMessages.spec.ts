import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { Message } from "$lib/types/Message";

vi.mock("../files/downloadFile", () => ({
	downloadFile: vi.fn(async (sha: string) => ({
		type: "base64",
		name: `raw-${sha}`,
		mime: "application/octet-stream",
		value: Buffer.from(`bytes of ${sha}`).toString("base64"),
	})),
}));

import { preprocessMessages } from "./preprocessMessages";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function message(files: NonNullable<Message["files"]>): Message {
	return { id: "m1" as Message["id"], from: "user", content: "read this", files };
}

async function textOf(files: NonNullable<Message["files"]>): Promise<string> {
	const [out] = await preprocessMessages([message(files)], new ObjectId());
	const file = out.files?.[0];
	expect(file?.mime).toBe("text/markdown");
	return Buffer.from(file?.value ?? "", "base64").toString("utf-8");
}

describe("the sentence a document with no text becomes", () => {
	it("says what actually failed, from the reason stored on the file", async () => {
		const text = await textOf([
			{
				type: "hash",
				value: "abc",
				mime: DOCX,
				name: "menu.docx",
				extractionError: { kind: "refused", reason: "not a Word 2007+ file" },
			},
		]);
		expect(text).toContain("refused this file: not a Word 2007+ file");
		expect(text).not.toMatch(/scan|OCR model/);
	});

	it("keeps the scan hint for a PDF with no text layer", async () => {
		const text = await textOf([
			{
				type: "hash",
				value: "abc",
				mime: "application/pdf",
				name: "scan.pdf",
				extractionError: { kind: "no-text", reason: "no text layer" },
			},
		]);
		expect(text).toContain("a model that reads images");
	});

	it("has no scan guess for an older file whose reason was never recorded", async () => {
		const text = await textOf([{ type: "hash", value: "abc", mime: DOCX, name: "old.docx" }]);
		expect(text).toContain("reason was not recorded");
		expect(text).not.toMatch(/scan|OCR model/);
	});

	it("treats a file stored as a compound file under an Office name as a document", async () => {
		const text = await textOf([
			{
				type: "hash",
				value: "abc",
				mime: "application/x-cfb",
				name: "legacy.docx",
				extractionError: { kind: "no-reader", reason: "No reader for Word documents." },
			},
		]);
		expect(text).toContain("no reader is configured");
	});

	it("hands any other file through untouched", async () => {
		const [out] = await preprocessMessages(
			[message([{ type: "hash", value: "abc", mime: "image/png", name: "a.png" }])],
			new ObjectId()
		);
		expect(out.files?.[0]).toMatchObject({ name: "raw-abc", mime: "application/octet-stream" });
	});
});

describe("a PDF's page images", () => {
	const TEXT = "Intro text.\n\n[[cerea:scan-page:2]]\n\nClosing text.\n\n[[cerea:scan-page:4]]";
	const pdf = (over: Record<string, unknown> = {}) =>
		({
			type: "hash",
			value: "pdfsha",
			mime: "application/pdf",
			name: "mixed.pdf",
			extracted: { value: "textsha", pages: 2 },
			pageImages: {
				files: [
					{ page: 4, value: "p4", mime: "image/jpeg" },
					{ page: 2, value: "p2", mime: "image/jpeg" },
				],
				pageCount: 4,
				scannedTotal: 2,
				truncated: false,
				...over,
			},
		}) as NonNullable<Message["files"]>[number];

	beforeEach(async () => {
		const { downloadFile } = await import("../files/downloadFile");
		vi.mocked(downloadFile).mockClear();
		vi.mocked(downloadFile).mockImplementation((async (sha: string) => ({
			type: "base64",
			name: `raw-${sha}`,
			mime: sha === "textsha" ? "text/markdown" : "image/jpeg",
			value: Buffer.from(sha === "textsha" ? TEXT : `bytes of ${sha}`).toString("base64"),
		})) as never);
	});

	const run = async (file: ReturnType<typeof pdf>, canReadImages: boolean) =>
		(await preprocessMessages([message([file])], new ObjectId(), canReadImages))[0].files ?? [];
	const text = (file?: { value: string }) => Buffer.from(file?.value ?? "", "base64").toString();

	it("to a model that reads images: one document in page order with markers, then the pages, in page order", async () => {
		const files = await run(pdf(), true);

		expect(files.map((f) => f.mime)).toEqual(["text/markdown", "image/jpeg", "image/jpeg"]);
		expect(files[0].name).toBe("mixed.pdf");
		expect(text(files[0])).toBe(
			[
				"PDF mixed.pdf: pages 2, 4 are scans, attached as images; the other pages are text below.",
				"Intro text.",
				"Page 2 is a scan, attached as an image.",
				"Closing text.",
				"Page 4 is a scan, attached as an image.",
			].join("\n\n")
		);
		expect(files.slice(1).map(text)).toEqual(["bytes of p2", "bytes of p4"]);
	});

	it("a fully scanned PDF is introduced as one, and truncation is said", async () => {
		const file = pdf({
			files: [
				{ page: 1, value: "p1", mime: "image/jpeg" },
				{ page: 2, value: "p2", mime: "image/jpeg" },
			],
			pageCount: 57,
			scannedTotal: 57,
			truncated: true,
		});
		expect(text((await run(file, true))[0])).toMatch(
			/^Scanned PDF mixed\.pdf: pages 1–2 attached as images\. Only the first 2 image pages of 57 were attached; the rest were not read\./
		);
	});

	it("to a model that cannot read images: the text, a sentence in place of each page, and no images read", async () => {
		const { downloadFile } = await import("../files/downloadFile");

		const files = await run(pdf(), false);

		expect(files).toHaveLength(1);
		const body = text(files[0]);
		expect(body).toMatch(
			/pages 2, 4 are a scan and the current model cannot read images, so those pages were not sent/
		);
		expect(body).toContain("model that reads images or an OCR reader");
		expect(body).toContain("Intro text.");
		expect(body).toContain(
			"Page 2 is a scan; its image was not sent because the current model cannot read images."
		);
		expect(body).not.toContain("attached as an image");
		const read = vi.mocked(downloadFile).mock.calls.map((call) => call[0]);
		expect(read).toEqual(["textsha"]);
	});

	it("is judged per turn: the same stored pages go out again after switching back", async () => {
		expect(await run(pdf(), false)).toHaveLength(1);
		expect(await run(pdf(), true)).toHaveLength(3);
	});

	it("reads a page listed twice once", async () => {
		const { downloadFile } = await import("../files/downloadFile");
		const file = pdf({
			files: [
				{ page: 1, value: "same", mime: "image/jpeg" },
				{ page: 2, value: "same", mime: "image/jpeg" },
			],
		});
		const files = await run(file, true);
		expect(files).toHaveLength(3);
		expect(vi.mocked(downloadFile).mock.calls.filter((c) => c[0] === "same")).toHaveLength(1);
	});
});

describe("where the original of an attachment is mounted", () => {
	it("names it on the text the model reads, and agrees across the whole conversation", async () => {
		// Two messages attach a file with the same name: the second is mounted as
		// "report (2).pdf", whichever branch this turn happens to send.
		const first = message([
			{
				type: "hash",
				value: "h1",
				mime: "application/pdf",
				name: "report.pdf",
				extractionError: { kind: "no-text", reason: "" },
			},
		]);
		const second = {
			...message([
				{
					type: "hash",
					value: "h2",
					mime: "application/pdf",
					name: "report.pdf",
					extractionError: { kind: "no-text", reason: "" },
				},
			]),
			id: "m2" as Message["id"],
		};
		const [out] = await preprocessMessages([second], new ObjectId(), false, [first, second]);
		expect(out.files?.[0].mountName).toBe("report (2).pdf");
	});

	it("is absent on a file that cannot be mounted (pasted text)", async () => {
		const [out] = await preprocessMessages(
			[
				message([
					{
						type: "base64",
						value: "aGk=",
						mime: "application/vnd.chatui.clipboard",
						name: "paste",
					},
				]),
			],
			new ObjectId()
		);
		expect(out.files?.[0]?.mountName).toBeUndefined();
	});
});
