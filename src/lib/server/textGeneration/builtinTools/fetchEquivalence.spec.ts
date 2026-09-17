import { describe, expect, it } from "vitest";
import { equivalentUrls } from "./fetchEquivalence";

describe("equivalentUrls", () => {
	it("maps a raw GitHub file to its blob-view counterpart", () => {
		expect(
			equivalentUrls("https://raw.githubusercontent.com/octocat/hello/main/README.md")
		).toEqual(["https://github.com/octocat/hello/blob/main/README.md"]);
	});

	it("maps a GitHub blob view to its raw-content counterpart", () => {
		expect(equivalentUrls("https://github.com/octocat/hello/blob/main/README.md")).toEqual([
			"https://raw.githubusercontent.com/octocat/hello/main/README.md",
		]);
	});

	it("handles nested paths", () => {
		expect(
			equivalentUrls("https://raw.githubusercontent.com/octocat/hello/main/src/lib/a.ts")
		).toEqual(["https://github.com/octocat/hello/blob/main/src/lib/a.ts"]);
	});

	it("finds nothing for an unrelated host", () => {
		expect(equivalentUrls("https://example.test/a")).toEqual([]);
	});

	it("finds nothing for a github.com URL that isn't a blob view", () => {
		expect(equivalentUrls("https://github.com/octocat/hello/issues/1")).toEqual([]);
	});

	it("finds nothing for an unparseable URL", () => {
		expect(equivalentUrls("not a url")).toEqual([]);
	});
});
