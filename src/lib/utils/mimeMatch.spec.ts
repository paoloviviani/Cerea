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
	const accept = ["text/*", ".jsonl", ".ndjson"];

	it("accepts .jsonl and .ndjson by extension whatever type the browser declared", () => {
		for (const type of [
			"",
			"application/octet-stream",
			"application/jsonl",
			"application/x-ndjson",
		]) {
			expect(fileMatchesAllowlist({ name: "rows.jsonl", type }, accept)).toBe(true);
			expect(fileMatchesAllowlist({ name: "Rows.NDJSON", type }, accept)).toBe(true);
		}
	});

	it("still judges other files by their type", () => {
		expect(fileMatchesAllowlist({ name: "a.txt", type: "text/plain" }, accept)).toBe(true);
		expect(fileMatchesAllowlist({ name: "a.bin", type: "application/octet-stream" }, accept)).toBe(
			false
		);
	});
});
