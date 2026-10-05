import { describe, expect, it } from "vitest";
import {
	MAX_ATTACHMENT_FILE_BYTES,
	MAX_ATTACHMENTS_TOTAL_BYTES,
	attachmentMountNotice,
	checkAttachmentCaps,
	mountNamesByHash,
	planAttachments,
	type AttachmentSource,
} from "./attachmentNames";

const hash = (value: string, name: string, extra: Partial<AttachmentSource> = {}) =>
	({ type: "hash", value, name, mime: "application/pdf", ...extra }) satisfies AttachmentSource;

describe("attachment mount names", () => {
	it("keeps the original name and puts the extracted text beside it", () => {
		const [plan] = planAttachments([hash("h1", "report.pdf", { extracted: { value: "t1" } })]);
		expect(plan.name).toBe("report.pdf");
		expect(plan.textName).toBe("report.pdf.md");
	});

	it("has no text name for a file with no extracted text", () => {
		expect(planAttachments([hash("h1", "scan.pdf")])[0].textName).toBeUndefined();
	});

	it("suffixes a clash before the extension, in order", () => {
		const plan = planAttachments([
			hash("h1", "report.pdf"),
			hash("h2", "report.pdf"),
			hash("h3", "report.pdf"),
			hash("h4", "notes"),
			hash("h5", "notes"),
		]);
		expect(plan.map((p) => p.name)).toEqual([
			"report.pdf",
			"report (2).pdf",
			"report (3).pdf",
			"notes",
			"notes (2)",
		]);
	});

	it("keeps the text names clear of every other file", () => {
		const plan = planAttachments([
			hash("h1", "a.pdf", { extracted: { value: "t1" } }),
			hash("h2", "a.pdf.md"),
			hash("h3", "a.pdf", { extracted: { value: "t3" } }),
		]);
		expect(plan.map((p) => [p.name, p.textName])).toEqual([
			["a.pdf", "a.pdf.md"],
			["a.pdf (2).md", undefined],
			["a (2).pdf", "a (2).pdf.md"],
		]);
	});

	it("mounts the same stored file once", () => {
		const plan = planAttachments([hash("h1", "a.csv"), hash("h1", "a.csv")]);
		expect(plan).toHaveLength(1);
	});

	it("cleans a name the way the sandbox would, and never exceeds its limit", () => {
		const [plan] = planAttachments([hash("h1", "../../etc/passwd")]);
		expect(plan.name).toBe("passwd");
		const long = `${"x".repeat(200)}.csv`;
		const names = planAttachments([
			hash("h1", long, { extracted: { value: "t1" } }),
			hash("h2", long),
		]);
		for (const entry of names) {
			expect(entry.name.length).toBeLessThanOrEqual(120);
			expect(entry.textName?.length ?? 0).toBeLessThanOrEqual(120);
		}
		expect(new Set(names.flatMap((n) => [n.name, n.textName]).filter(Boolean)).size).toBe(3);
	});

	it("skips pasted text, which has no bytes to mount", () => {
		expect(
			planAttachments([
				{ type: "base64", value: "aGk=", name: "paste", mime: "application/vnd.chatui.clipboard" },
			])
		).toEqual([]);
	});

	it("is what the prompt and the mounter both read: hash to mount name", () => {
		const names = mountNamesByHash([hash("h1", "a.pdf"), hash("h2", "a.pdf")]);
		expect(names.get("h1")).toBe("a.pdf");
		expect(names.get("h2")).toBe("a (2).pdf");
		expect(attachmentMountNotice(names.get("h2") as string)).toBe(
			"The original file is available to code at /mnt/data/a (2).pdf."
		);
	});
});

describe("attachment caps", () => {
	it("takes a file up to 20 MB and refuses one over", () => {
		expect(checkAttachmentCaps(0, MAX_ATTACHMENT_FILE_BYTES)).toBe("ok");
		expect(checkAttachmentCaps(0, MAX_ATTACHMENT_FILE_BYTES + 1)).toBe("file");
	});

	it("stops at 100 MB in total", () => {
		const mb = 1024 * 1024;
		expect(checkAttachmentCaps(MAX_ATTACHMENTS_TOTAL_BYTES - 10 * mb, 10 * mb)).toBe("ok");
		expect(checkAttachmentCaps(MAX_ATTACHMENTS_TOTAL_BYTES - 10 * mb, 10 * mb + 1)).toBe("total");
	});
});
