import { describe, expect, it, vi } from "vitest";
import superjson from "superjson";

import {
	CLIPBOARD_MIME,
	LONG_PASTE_CHARS,
	pastedAttachments,
	uploadComposerFiles,
} from "./composerFiles";

/** Enough of a DataTransfer for a paste: its text, and its files. */
function clipboard(text: string, files: File[] = []): DataTransfer {
	return { getData: () => text, files } as unknown as DataTransfer;
}

const png = new File(["x"], "a.png", { type: "image/png" });
const exe = new File(["x"], "a.exe", { type: "application/x-msdownload" });

describe("pastedAttachments", () => {
	it("leaves a short text paste to the browser", () => {
		expect(pastedAttachments(clipboard("hello"), { mimeTypes: ["image/*"] })).toEqual({
			files: [],
			preventDefault: false,
			longText: false,
		});
	});

	it("turns a long text paste into a clipboard chip, unless directPaste is on", () => {
		const long = "a".repeat(LONG_PASTE_CHARS);
		const chip = pastedAttachments(clipboard(long), { mimeTypes: [] });
		expect(chip.preventDefault).toBe(true);
		expect(chip.longText).toBe(true);
		expect(chip.files).toHaveLength(1);
		expect(chip.files[0]).toMatchObject({ name: "Pasted Content", type: CLIPBOARD_MIME });

		const direct = pastedAttachments(clipboard(long), { mimeTypes: [], directPaste: true });
		expect(direct).toEqual({ files: [], preventDefault: false, longText: false });
	});

	it("keeps pasted files the allowlist admits, wildcards included, and drops the rest", () => {
		const pasted = pastedAttachments(clipboard("", [png, exe]), { mimeTypes: ["image/*"] });
		expect(pasted.files).toEqual([png]);
		// Refused files are still the composer's paste, not the browser's.
		expect(pasted.preventDefault).toBe(true);
	});

	it("tolerates a paste with no clipboard data", () => {
		expect(pastedAttachments(null, { mimeTypes: [] }).files).toEqual([]);
	});
});

describe("uploadComposerFiles", () => {
	it("posts messageId and each file, and returns the stored references", async () => {
		const stored = [{ type: "hash", value: "abc", mime: "image/png", name: "a.png" }];
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			const form = init?.body as FormData;
			expect(form.get("messageId")).toBe("msg-1");
			expect(form.getAll("files")).toHaveLength(1);
			return new Response(superjson.stringify({ files: stored }));
		});
		await expect(
			uploadComposerFiles("/up", "msg-1", [png], fetchImpl as unknown as typeof fetch)
		).resolves.toEqual(stored);
		expect(fetchImpl).toHaveBeenCalledWith("/up", expect.objectContaining({ method: "POST" }));
	});

	it("does not call the endpoint with nothing to upload", async () => {
		const fetchImpl = vi.fn();
		await expect(
			uploadComposerFiles("/up", "m", [], fetchImpl as unknown as typeof fetch)
		).resolves.toEqual([]);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("surfaces the server's refusal", async () => {
		const fetchImpl = async () =>
			new Response(JSON.stringify({ message: "File too large, should be <10MB" }), {
				status: 413,
			});
		await expect(
			uploadComposerFiles("/up", "m", [png], fetchImpl as unknown as typeof fetch)
		).rejects.toThrow("File too large");
	});
});
