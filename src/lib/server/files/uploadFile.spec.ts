/**
 * `uploadFile` with real bytes, against the real bucket: which type the bytes
 * sniff as, what the extractor is handed, and what the stored `MessageFile`
 * says. Extraction itself is mocked (it would call the gateway); the type
 * decisions around it stay real.
 *
 * The case that started this: a legacy `.doc` saved with a `.docx` name sniffs
 * as `application/x-cfb` while the browser says "docx", and extraction used to
 * be skipped silently on the first while the second was what got stored.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { strToU8, zipSync } from "fflate";

const { extractMock } = vi.hoisted(() => ({ extractMock: vi.fn() }));

vi.mock("$lib/server/files/extractDocument", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./extractDocument")>();
	return { ...actual, extractDocument: extractMock };
});

import { collections, ready } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import { uploadFile } from "./uploadFile";
import { storeAttachment, findAttachments, deleteAttachmentsByPrefix } from "./attachmentStore";
import { deleteConversationAttachments } from "./deleteConversationAttachments";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

beforeAll(async () => {
	await ready;
});

const conversations: ObjectId[] = [];
const devices: string[] = [];

afterEach(async () => {
	extractMock.mockReset();
	for (const id of devices.splice(0)) await deleteAttachmentsByPrefix(`code:${id}:`);
	await deleteConversationAttachments(conversations.splice(0));
});

function conversation(): Conversation {
	const _id = new ObjectId();
	conversations.push(_id);
	return { _id } as Conversation;
}

/** A real, minimal Word 2007+ file: what `file-type` recognises as docx. */
function realDocx(): Buffer {
	return Buffer.from(
		zipSync({
			"[Content_Types].xml": strToU8(
				`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
			),
			"word/document.xml": strToU8(
				`<w:document><w:body><w:p><w:r><w:t>Menu</w:t></w:r></w:p></w:body></w:document>`
			),
		})
	);
}

/** The compound-file header every binary Office file starts with. */
function cfbBytes(): Buffer {
	const bytes = Buffer.alloc(1024);
	bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
	return bytes;
}

function fileOf(bytes: Uint8Array, name: string, type: string): File {
	return new File([bytes as BlobPart], name, { type });
}

const OK = { ok: true, text: "# Menu", pages: 1 };

describe("uploadFile: which type decides", () => {
	it("a real .docx is sniffed as docx and extracted under that type", async () => {
		extractMock.mockResolvedValue(OK);
		const bytes = realDocx();
		const stored = await uploadFile(fileOf(bytes, "menu.docx", DOCX), conversation(), "tok");

		expect(extractMock).toHaveBeenCalledTimes(1);
		expect(extractMock.mock.calls[0][0]).toMatchObject({ mime: DOCX, filename: "menu.docx" });
		expect(stored).toMatchObject({ mime: DOCX, name: "menu.docx", extracted: { pages: 1 } });
		expect(stored.extractionError).toBeUndefined();
	});

	it("a compound file named .docx is sent to the reader, bytes intact, as msword", async () => {
		extractMock.mockResolvedValue(OK);
		const bytes = cfbBytes();
		const stored = await uploadFile(
			fileOf(bytes, "MENU' autunno inverno.doc.docx", DOCX),
			conversation(),
			"tok"
		);

		expect(extractMock).toHaveBeenCalledTimes(1);
		const call = extractMock.mock.calls[0][0];
		expect(call.mime).toBe("application/msword");
		expect(Buffer.from(call.bytes).equals(bytes)).toBe(true);
		// The stored type and the type that decided are one and the same.
		expect(stored.mime).toBe("application/msword");
		expect(stored.extracted).toBeDefined();
	});

	it("a compound file with no Office name is stored, not extracted, and not mislabelled", async () => {
		const stored = await uploadFile(
			fileOf(cfbBytes(), "installer.msi", "application/x-msi"),
			conversation(),
			"tok"
		);
		expect(extractMock).not.toHaveBeenCalled();
		expect(stored.mime).toBe("application/x-cfb");
		expect(stored.extractionError).toBeUndefined();
	});

	it("a PDF goes through as a PDF", async () => {
		extractMock.mockResolvedValue(OK);
		const stored = await uploadFile(
			fileOf(Buffer.from("%PDF-1.4\n%pretend\n"), "a.pdf", "application/pdf"),
			conversation(),
			"tok"
		);
		expect(extractMock.mock.calls[0][0]).toMatchObject({ mime: "application/pdf" });
		expect(stored.mime).toBe("application/pdf");
	});
});

describe("uploadFile: a failure keeps its reason", () => {
	it("persists the extractor's reason and kind on the MessageFile, and stores the file", async () => {
		extractMock.mockResolvedValue({
			ok: false,
			kind: "refused",
			status: 422,
			reason: "this is a legacy .doc and antiword is not installed",
		});
		const conv = conversation();
		const stored = await uploadFile(fileOf(cfbBytes(), "menu.docx", DOCX), conv, "tok");

		expect(stored.extracted).toBeUndefined();
		expect(stored.extractionError).toEqual({
			kind: "refused",
			reason: "this is a legacy .doc and antiword is not installed",
		});
		const rows = await collections.bucket
			.find({ "metadata.conversation": conv._id.toString() })
			.toArray();
		expect(rows).toHaveLength(1);
	});

	it("survives the owner-keyed store's rebuild from the bucket", async () => {
		extractMock.mockResolvedValue({
			ok: false,
			kind: "no-reader",
			status: 503,
			reason: "No reader for Word documents is configured",
		});
		const device = new ObjectId().toHexString();
		devices.push(device);
		const key = `code:${device}:ses_x`;
		const stored = await storeAttachment(
			fileOf(cfbBytes(), "menu.docx", DOCX),
			key,
			"msg-1",
			"tok"
		);

		expect(stored.extractionError?.kind).toBe("no-reader");
		expect(await findAttachments(key, "msg-1")).toEqual([stored]);
	});
});
