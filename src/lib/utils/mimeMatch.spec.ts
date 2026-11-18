import { describe, expect, it } from "vitest";
import { fileMatchesAllowlist, mimeMatchesAllowlist } from "./mimeMatch";

describe("mimeMatchesAllowlist", () => {
	it("matches exact types", () => {
		expect(mimeMatchesAllowlist("image/png", ["image/png"])).toBe(true);
		expect(mimeMatchesAllowlist("image/png", ["image/jpeg", "image/png"])).toBe(true);
	});

	it("matches wildcard subtypes", () => {
		expect(mimeMatchesAllowlist("text/plain", ["text/*"])).toBe(true);
		expect(mimeMatchesAllowlist("text/markdown", ["text/*"])).toBe(true);
		expect(mimeMatchesAllowlist("image/png", ["text/*"])).toBe(false);
	});

	it("matches a full wildcard", () => {
		expect(mimeMatchesAllowlist("application/pdf", ["*/*"])).toBe(true);
	});

	it("rejects types not in the allowlist", () => {
		expect(mimeMatchesAllowlist("image/png", ["text/*", "application/json"])).toBe(false);
		expect(mimeMatchesAllowlist("image/svg+xml", ["image/png", "image/jpeg"])).toBe(false);
	});

	it("rejects everything on an empty allowlist", () => {
		expect(mimeMatchesAllowlist("image/png", [])).toBe(false);
	});
});

describe("fileMatchesAllowlist", () => {
	const accept = ["text/*", "application/pdf"];

	it("does not turn away text by its extension or type: the server reads the bytes", () => {
		for (const name of ["rows.jsonl", "diagram.drawio", "scene.excalidraw", "x.foo", "Makefile"]) {
			for (const type of ["", "application/octet-stream", "application/x-ndjson"]) {
				expect(fileMatchesAllowlist({ name, type }, accept)).toBe(true);
			}
		}
	});

	it("still judges images and audio by type, and everything when text is not taken", () => {
		expect(fileMatchesAllowlist({ name: "a.png", type: "image/png" }, accept)).toBe(false);
		expect(fileMatchesAllowlist({ name: "a.mp3", type: "audio/mpeg" }, accept)).toBe(false);
		expect(fileMatchesAllowlist({ name: "a.png", type: "image/png" }, ["image/*"])).toBe(true);
		expect(fileMatchesAllowlist({ name: "a.foo", type: "" }, ["image/*"])).toBe(false);
	});
});
