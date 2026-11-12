import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { MessageFile } from "$lib/types/Message";
import { saveBrowserDownloads } from "./downloads";

const conversationId = new ObjectId();
const b64 = (text: string) => Buffer.from(text).toString("base64");

function seams(options: { withheld?: boolean; storeFails?: boolean } = {}) {
	const attach = vi.fn(
		async (file: File, _owner?: string, _token?: string): Promise<MessageFile> => ({
			type: "hash",
			value: "sha",
			mime: file.type,
			name: file.name,
			...(options.withheld ? { withheld: { rule: "no-health-data", pipeline: "strict" } } : {}),
		})
	);
	const store = vi.fn(async (input: { name: string; bytes: Buffer }) =>
		options.storeFails
			? { ok: false as const, status: 413 as const, error: "limit reached" }
			: {
					ok: true as const,
					ref: { name: input.name, size: input.bytes.byteLength, sha256: "x" },
				}
	);
	return { attach, store };
}

describe("saveBrowserDownloads", () => {
	it("screens a file as the user attached it, then stores it for the conversation", async () => {
		const s = seams();
		const [saved] = await saveBrowserDownloads(
			[{ name: "report.pdf", mime: "application/pdf", size: 5, base64: b64("%PDF-") }],
			{
				conversationId,
				token: "user-token",
				messageId: "m1",
				attach: s.attach as never,
				store: s.store as never,
			}
		);
		// The privacy pipelines run at the attachment write, with the user's own token.
		expect(s.attach).toHaveBeenCalledTimes(1);
		expect(s.attach.mock.calls[0][1]).toBe(conversationId.toString());
		expect(s.attach.mock.calls[0][2]).toBe("user-token");
		expect(s.store).toHaveBeenCalledWith(
			expect.objectContaining({ name: "report.pdf", tool: "browse", messageId: "m1" })
		);
		expect(saved).toMatchObject({ name: "report.pdf", size: 5, saved: true });
		expect(saved.note).toContain("file saved to this conversation: report.pdf");
	});

	it("keeps a withheld file withheld: not stored for tools, and said so", async () => {
		const s = seams({ withheld: true });
		const [saved] = await saveBrowserDownloads(
			[{ name: "results.pdf", mime: "application/pdf", size: 5, base64: b64("%PDF-") }],
			{ conversationId, attach: s.attach as never, store: s.store as never }
		);
		expect(s.store).not.toHaveBeenCalled();
		expect(saved).toMatchObject({ name: "results.pdf", saved: false });
		expect(saved.note).toContain("withheld by the privacy rule 'no-health-data'");
		expect(saved.note).toContain("must not be read");
	});

	it("reports a file the runtime left out, without bytes", async () => {
		const s = seams();
		const [saved] = await saveBrowserDownloads(
			[{ name: "big.zip", mime: "application/zip", size: 99, skipped: "larger than the limit" }],
			{ conversationId, attach: s.attach as never, store: s.store as never }
		);
		expect(s.attach).not.toHaveBeenCalled();
		expect(saved).toMatchObject({ saved: false });
		expect(saved.note).toContain("larger than the limit");
	});

	it("refuses a file over the size limit", async () => {
		const s = seams();
		const big = Buffer.alloc(26 * 1024 * 1024).toString("base64");
		const [saved] = await saveBrowserDownloads(
			[{ name: "huge.bin", mime: "application/octet-stream", size: 26 * 1024 * 1024, base64: big }],
			{ conversationId, attach: s.attach as never, store: s.store as never }
		);
		expect(s.attach).not.toHaveBeenCalled();
		expect(saved.saved).toBe(false);
		expect(saved.note).toContain("larger than the file size limit");
	});

	it("reports the store's refusal, and a failure, as not saved", async () => {
		const full = seams({ storeFails: true });
		const [a] = await saveBrowserDownloads(
			[{ name: "a.txt", mime: "text/plain", size: 1, base64: b64("a") }],
			{ conversationId, attach: full.attach as never, store: full.store as never }
		);
		expect(a).toMatchObject({ saved: false });
		expect(a.note).toContain("limit reached");

		const broken = {
			attach: vi.fn(async () => {
				throw new Error("gateway down");
			}),
			store: vi.fn(),
		};
		const [b] = await saveBrowserDownloads(
			[{ name: "b.txt", mime: "text/plain", size: 1, base64: b64("b") }],
			{ conversationId, attach: broken.attach as never, store: broken.store as never }
		);
		expect(b.saved).toBe(false);
		expect(b.note).toContain("gateway down");
		expect(broken.store).not.toHaveBeenCalled();
	});

	it("cleans a file name from the web", async () => {
		const s = seams();
		const [saved] = await saveBrowserDownloads(
			[{ name: "../../etc/passwd", mime: "text/plain", size: 1, base64: b64("x") }],
			{ conversationId, attach: s.attach as never, store: s.store as never }
		);
		expect(saved.name).toBe("passwd");
	});
});
