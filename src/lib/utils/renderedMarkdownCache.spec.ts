import { describe, expect, it } from "vitest";
import type { BlockToken } from "$lib/utils/markedLight";
import { cachedMarkdownBlocks, rememberMarkdownBlocks } from "./renderedMarkdownCache";

const blocks = (id: string) => [{ id, tokens: [] }] as unknown as BlockToken[];

describe("renderedMarkdownCache", () => {
	it("returns a render only for the same content and sources", () => {
		const b = blocks("a");
		rememberMarkdownBlocks("hello", [], b);
		expect(cachedMarkdownBlocks("hello", [])).toBe(b);
		expect(cachedMarkdownBlocks("hello!", [])).toBeNull();
		expect(cachedMarkdownBlocks("hello", [{ link: "https://x.test" }])).toBeNull();
	});

	it("evicts the least recently used entry past its bound", () => {
		rememberMarkdownBlocks("keep", [], blocks("keep"));
		for (let i = 0; i < 199; i++) rememberMarkdownBlocks(`filler ${i}`, [], blocks(`f${i}`));
		expect(cachedMarkdownBlocks("keep", [])).not.toBeNull(); // touched: now most recent
		rememberMarkdownBlocks("one more", [], blocks("m"));
		expect(cachedMarkdownBlocks("keep", [])).not.toBeNull();
		expect(cachedMarkdownBlocks("filler 0", [])).toBeNull();
	});

	it("does not keep very large content", () => {
		const big = "x".repeat(100_001);
		rememberMarkdownBlocks(big, [], blocks("big"));
		expect(cachedMarkdownBlocks(big, [])).toBeNull();
	});
});
