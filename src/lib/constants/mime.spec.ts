import { describe, expect, it } from "vitest";
import { attachmentSizeRefusal } from "./mime";

const MB = 1024 * 1024;

describe("attachmentSizeRefusal", () => {
	it("lets a 17 MB recording through and refuses 26 MB with the audio wording", () => {
		expect(attachmentSizeRefusal({ name: "a.mp3", size: 17 * MB, type: "audio/mpeg" })).toBeNull();
		expect(attachmentSizeRefusal({ name: "a.mp3", size: 25 * MB, type: "audio/mpeg" })).toBeNull();
		expect(attachmentSizeRefusal({ name: "a.mp3", size: 26 * MB, type: "audio/mpeg" })).toMatch(
			/too long to transcribe here: up to 25 MB \(about 25 minutes\)/
		);
	});

	it("keeps 10 MB for every other type", () => {
		expect(
			attachmentSizeRefusal({ name: "d.pdf", size: 12 * MB, type: "application/pdf" })
		).toMatch(/limited to 10 MB/);
		expect(attachmentSizeRefusal({ name: "d.txt", size: 10 * MB, type: "text/plain" })).toBeNull();
	});
});
