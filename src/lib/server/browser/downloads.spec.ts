import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { MessageFile } from "$lib/types/Message";
import type { MessageFileUpdate } from "$lib/types/MessageUpdate";
import { saveBrowserDownloads } from "./downloads";

const conversationId = new ObjectId();
const b64 = (text: string) => Buffer.from(text).toString("base64");

function seams(options: { withheld?: boolean; attachFails?: boolean } = {}) {
	const attach = vi.fn(
		async (
			file: File,
			_owner?: string,
			_token?: string,
			_tag?: unknown,
			_opts?: unknown
		): Promise<MessageFile> => {
			if (options.attachFails) throw new Error("gateway down");
			return {
				type: "hash",
				value: "sha-of-" + file.name,
				mime: file.type,
				name: file.name,
				...(options.withheld ? { withheld: { rule: "no-health-data", pipeline: "strict" } } : {}),
			};
		}
	);
	const files: MessageFileUpdate[] = [];
	return { attach, files, emitFile: (u: MessageFileUpdate) => void files.push(u) };
}

describe("saveBrowserDownloads (stored once, as an attachment)", () => {
	it("writes the attachment the way a user's is (token, no transcription) and lists it on the message", async () => {
		const s = seams();
		const [saved] = await saveBrowserDownloads(
			[{ name: "report.pdf", mime: "application/pdf", size: 5, base64: b64("%PDF-") }],
			{ conversationId, token: "user-token", attach: s.attach as never, emitFile: s.emitFile }
		);
		expect(s.attach).toHaveBeenCalledTimes(1);
		const call = s.attach.mock.calls[0];
		expect(call[1]).toBe(conversationId.toString());
		expect(call[2]).toBe("user-token");
		expect(call[4]).toEqual({ skipTranscription: true });
		expect(s.files).toEqual([
			{ type: "file", name: "report.pdf", sha: "sha-of-report.pdf", mime: "application/pdf" },
		]);
		expect(saved).toMatchObject({ name: "report.pdf", size: 5, saved: true });
		expect(saved.note).toContain("file saved to this conversation: report.pdf");
	});

	it("never stores a second copy: there is one write per file", async () => {
		const s = seams();
		await saveBrowserDownloads(
			[
				{ name: "a.txt", mime: "text/plain", size: 1, base64: b64("a") },
				{ name: "b.txt", mime: "text/plain", size: 1, base64: b64("b") },
			],
			{ conversationId, attach: s.attach as never, emitFile: s.emitFile }
		);
		expect(s.attach).toHaveBeenCalledTimes(2);
		expect(s.files).toHaveLength(2);
	});

	it("keeps a withheld file withheld: listed with its mark, reported as withheld, never as saved", async () => {
		const s = seams({ withheld: true });
		const [saved] = await saveBrowserDownloads(
			[{ name: "results.pdf", mime: "application/pdf", size: 5, base64: b64("%PDF-") }],
			{ conversationId, attach: s.attach as never, emitFile: s.emitFile }
		);
		expect(s.files[0].withheld).toEqual({ rule: "no-health-data", pipeline: "strict" });
		expect(saved).toMatchObject({ name: "results.pdf", saved: false });
		expect(saved.note).toContain("withheld by the privacy rule 'no-health-data'");
		expect(saved.note).toContain("must not be read");
	});

	it("reports a file the runtime left out, without bytes", async () => {
		const s = seams();
		const [saved] = await saveBrowserDownloads(
			[{ name: "big.zip", mime: "application/zip", size: 99, skipped: "larger than the limit" }],
			{ conversationId, attach: s.attach as never }
		);
		expect(s.attach).not.toHaveBeenCalled();
		expect(saved).toMatchObject({ saved: false });
		expect(saved.note).toContain("larger than the limit");
	});

	it("checks the size on the text, before decoding it", async () => {
		const s = seams();
		const fromBase64 = vi.spyOn(Buffer, "from");
		const huge = "A".repeat(Math.ceil((26 * 1024 * 1024 * 4) / 3));
		const [saved] = await saveBrowserDownloads(
			[
				{
					name: "huge.bin",
					mime: "application/octet-stream",
					size: 26 * 1024 * 1024,
					base64: huge,
				},
			],
			{ conversationId, attach: s.attach as never }
		);
		expect(fromBase64).not.toHaveBeenCalledWith(huge, "base64");
		fromBase64.mockRestore();
		expect(s.attach).not.toHaveBeenCalled();
		expect(saved.saved).toBe(false);
		expect(saved.note).toContain("larger than the file size limit");
	});

	it("reports a failure as not saved", async () => {
		const s = seams({ attachFails: true });
		const [saved] = await saveBrowserDownloads(
			[{ name: "b.txt", mime: "text/plain", size: 1, base64: b64("b") }],
			{ conversationId, attach: s.attach as never, emitFile: s.emitFile }
		);
		expect(saved.saved).toBe(false);
		expect(saved.note).toContain("gateway down");
		expect(s.files).toEqual([]);
	});

	it("cleans a file name from the web", async () => {
		const s = seams();
		const [saved] = await saveBrowserDownloads(
			[{ name: "../../etc/passwd", mime: "text/plain", size: 1, base64: b64("x") }],
			{ conversationId, attach: s.attach as never }
		);
		expect(saved.name).toBe("passwd");
	});
});
