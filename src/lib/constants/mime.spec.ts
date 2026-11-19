import { describe, expect, it } from "vitest";
import { attachmentSizeRefusal, attachmentsTotalFit, MAX_MESSAGE_ATTACHMENTS_BYTES } from "./mime";

const MB = 1024 * 1024;

describe("attachmentSizeRefusal", () => {
	it("lets a 17 MB recording through and refuses 26 MB with the audio wording", () => {
		expect(attachmentSizeRefusal({ name: "a.mp3", size: 17 * MB, type: "audio/mpeg" })).toBeNull();
		expect(attachmentSizeRefusal({ name: "a.mp3", size: 25 * MB, type: "audio/mpeg" })).toBeNull();
		expect(attachmentSizeRefusal({ name: "a.mp3", size: 26 * MB, type: "audio/mpeg" })).toMatch(
			/too long to transcribe here: up to 25 MB \(about 25 minutes\)/
		);
	});

	it("allows 30 MB for every other type", () => {
		expect(
			attachmentSizeRefusal({ name: "d.pdf", size: 31 * MB, type: "application/pdf" })
		).toMatch(/limited to 30 MB/);
		expect(
			attachmentSizeRefusal({ name: "d.pdf", size: 29 * MB, type: "application/pdf" })
		).toBeNull();
		expect(attachmentSizeRefusal({ name: "d.txt", size: 30 * MB, type: "text/plain" })).toBeNull();
	});
});

describe("text attachments", () => {
	it("offers every file in the knowledge and project pickers, and the agent ceiling takes text", async () => {
		const m = await import("./mime");
		expect(m.KNOWLEDGE_ACCEPT).toBe("*/*");
		expect(m.AGENT_ATTACHMENT_MIME_ALLOWLIST).toContain("text/*");
	});
});

describe("attachmentsTotalFit", () => {
	it("keeps all the files of one message under the request body limit", () => {
		expect(MAX_MESSAGE_ATTACHMENTS_BYTES).toBeLessThan(100 * MB);
		expect(attachmentsTotalFit([30 * MB, 30 * MB, 29 * MB])).toBe(true);
		expect(attachmentsTotalFit([30 * MB, 30 * MB, 30 * MB, 1 * MB])).toBe(false);
		expect(attachmentsTotalFit([])).toBe(true);
	});
});
