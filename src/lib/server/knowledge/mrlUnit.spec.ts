import { describe, expect, it } from "vitest";
import { isMrlModel, truncateRenormalise } from "./mrl";

describe("MRL allowlist", () => {
	it("matches known families case-insensitively, with prefixes and suffixes", () => {
		for (const id of [
			"qwen3-embedding-8b",
			"cortecs/Qwen3-Embedding-8B",
			"OpenAI/text-embedding-3-large",
			"nomic-embed-text-v1.5",
			"mxbai-embed-large-v1",
		]) {
			expect(isMrlModel(id)).toBe(true);
		}
		for (const id of ["text-embedding-ada-002", "bge-m3", "all-minilm", "embed-test"]) {
			expect(isMrlModel(id)).toBe(false);
		}
	});

	it("cuts and renormalises", () => {
		const v = truncateRenormalise([3, 4, 12, 99], 2);
		expect(v).toEqual([0.6, 0.8]);
	});
});
