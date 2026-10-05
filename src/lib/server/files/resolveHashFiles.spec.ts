import { describe, expect, it, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import type { Conversation } from "$lib/types/Conversation";
import type { MessageFile } from "$lib/types/Message";

const { uploadFileMock, downloadFileMock } = vi.hoisted(() => ({
	uploadFileMock: vi.fn(),
	downloadFileMock: vi.fn(),
}));
vi.mock("./uploadFile", () => ({ uploadFile: uploadFileMock }));
vi.mock("./downloadFile", () => ({ downloadFile: downloadFileMock }));

import { resolveHashFiles } from "./resolveHashFiles";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function conv(files: MessageFile[]): Conversation {
	return {
		_id: new ObjectId(),
		messages: [{ id: "m1", from: "user", content: "Write the menu", files }],
	} as unknown as Conversation;
}

beforeEach(() => {
	uploadFileMock.mockReset();
	downloadFileMock.mockReset();
});

describe("resolveHashFiles", () => {
	it("a resent document takes the extraction recorded at its upload", async () => {
		const recorded: MessageFile = {
			type: "hash",
			value: "abc",
			mime: DOCX,
			name: "menu.docx",
			extracted: { value: "txt", pages: 1 },
		};
		const [file] = await resolveHashFiles(
			[{ type: "hash", value: "abc", mime: DOCX, name: "menu.docx" }],
			conv([recorded]),
			"t"
		);
		expect(file.extracted).toEqual({ value: "txt", pages: 1 });
		expect(uploadFileMock).not.toHaveBeenCalled();
	});

	it("a document with nothing on record is read again from the stored bytes", async () => {
		downloadFileMock.mockResolvedValue({ type: "base64", value: "aGk=", mime: DOCX, name: "x" });
		uploadFileMock.mockResolvedValue({
			type: "hash",
			value: "abc",
			mime: DOCX,
			name: "menu.docx",
			extracted: { value: "new", pages: 1 },
		});
		const bare: MessageFile = { type: "hash", value: "abc", mime: DOCX, name: "menu.docx" };
		const [file] = await resolveHashFiles([bare], conv([bare]), "t");
		expect(uploadFileMock).toHaveBeenCalledTimes(1);
		expect(file.extracted?.value).toBe("new");
	});

	it("an image reference passes through untouched, with no re-read", async () => {
		const image: MessageFile = { type: "hash", value: "img", mime: "image/png", name: "a.png" };
		const [file] = await resolveHashFiles([image], conv([image]), "t");
		expect(file).toEqual(image);
		expect(downloadFileMock).not.toHaveBeenCalled();
	});
});
