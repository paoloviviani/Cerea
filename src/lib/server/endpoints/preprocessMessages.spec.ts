import { describe, expect, it, vi } from "vitest";
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
		expect(text).toContain("needs an OCR model");
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
