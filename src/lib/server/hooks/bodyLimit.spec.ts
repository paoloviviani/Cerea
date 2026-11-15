import { describe, expect, it } from "vitest";
import { bodyTooLarge } from "./handle";

const MB = 1024 * 1024;
const big = String(50 * MB);

describe("bodyTooLarge", () => {
	it("lets the conversation POST and dictation carry a 50 MB body (30 MB files, 25 MB audio)", () => {
		expect(
			bodyTooLarge({ method: "POST", pathname: "/conversation/abc123", contentLength: big })
		).toBe(false);
		expect(bodyTooLarge({ method: "POST", pathname: "/api/transcribe", contentLength: big })).toBe(
			false
		);
		expect(
			bodyTooLarge({
				method: "POST",
				pathname: "/chat/conversation/abc",
				contentLength: big,
				base: "/chat",
			})
		).toBe(false);
	});

	it("lets the /code attachment upload and a project's documents carry it too", () => {
		for (const pathname of [
			"/api/v2/code/attachments/code%3Adev%3Ases",
			"/api/v2/projects/p/documents",
		]) {
			expect(bodyTooLarge({ method: "POST", pathname, contentLength: big })).toBe(false);
		}
		// Only the upload itself, not what lives beside it.
		expect(
			bodyTooLarge({
				method: "POST",
				pathname: "/api/v2/projects/p/documents/d",
				contentLength: big,
			})
		).toBe(true);
	});

	it("keeps every other route at 15 MB", () => {
		for (const pathname of [
			"/api/v2/skills",
			"/api/v2/custom-models",
			"/conversation/abc/code-execution/output",
		]) {
			expect(bodyTooLarge({ method: "POST", pathname, contentLength: big })).toBe(true);
			expect(bodyTooLarge({ method: "POST", pathname, contentLength: String(14 * MB) })).toBe(
				false
			);
		}
	});

	it("ignores reads and a missing length", () => {
		expect(bodyTooLarge({ method: "GET", pathname: "/x", contentLength: big })).toBe(false);
		expect(bodyTooLarge({ method: "POST", pathname: "/x", contentLength: null })).toBe(false);
	});
});
