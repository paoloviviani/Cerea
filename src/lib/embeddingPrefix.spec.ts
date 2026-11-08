import { describe, expect, it } from "vitest";
import {
	MAX_PREFIX_LENGTH,
	PRESETS,
	applyPrefix,
	detectPreset,
	passagePrefixChanged,
	prefixFor,
	validatePrefix,
} from "./embeddingPrefix";

describe("applyPrefix", () => {
	it("prepends, leaves text alone when the prefix is empty, never doubles", () => {
		expect(applyPrefix("passage: ", "hello")).toBe("passage: hello");
		expect(applyPrefix("", "hello")).toBe("hello");
		expect(applyPrefix(undefined, "hello")).toBe("hello");
		expect(applyPrefix("passage: ", "passage: hello")).toBe("passage: hello");
	});
});

describe("prefixFor", () => {
	const base = { embeddingModel: "e5", passagePrefix: "passage: ", queryPrefix: "old: " };
	it("passages use the prefix the base was indexed with", () => {
		expect(prefixFor("passage", base, { embeddingModel: "e5", queryPrefix: "q: " })).toBe(
			"passage: "
		);
		expect(prefixFor("passage", { embeddingModel: "e5" }, { embeddingModel: "e5" })).toBe("");
	});
	it("queries use the current prefix on the current model, the recorded one otherwise", () => {
		expect(prefixFor("query", base, { embeddingModel: "e5", queryPrefix: "query: " })).toBe(
			"query: "
		);
		expect(prefixFor("query", base, { embeddingModel: "other", queryPrefix: "x: " })).toBe("old: ");
		expect(prefixFor("query", { embeddingModel: "e5" }, { embeddingModel: "other" })).toBe("");
	});
});

describe("detectPreset", () => {
	it("recognises e5, bge v1.5 and nomic", () => {
		expect(detectPreset("intfloat/multilingual-e5-small")).toBe(PRESETS.e5);
		expect(detectPreset("e5-large-v2")).toBe(PRESETS.e5);
		expect(detectPreset("BAAI/bge-small-en-v1.5")).toBe(PRESETS.bge);
		expect(detectPreset("nomic-embed-text-v1.5")).toBe(PRESETS.nomic);
	});
	it("gives bge a query prefix only", () => {
		expect(PRESETS.bge.passage).toBe("");
		expect(PRESETS.bge.query).toBe("Represent this sentence for searching relevant passages: ");
	});
	it("knows nothing else", () => {
		for (const id of ["bge-m3", "bge-large-en", "text-embedding-3-small", "", null, undefined]) {
			expect(detectPreset(id)).toBeNull();
		}
	});
});

describe("validatePrefix", () => {
	it("accepts empty, ordinary and 200-character text", () => {
		expect(validatePrefix("")).toBeNull();
		expect(validatePrefix("query: ")).toBeNull();
		expect(validatePrefix("x".repeat(MAX_PREFIX_LENGTH))).toBeNull();
	});
	it("refuses long text, control characters and non-strings", () => {
		expect(validatePrefix("x".repeat(MAX_PREFIX_LENGTH + 1))).toMatch(/200/);
		expect(validatePrefix("a\nb")).toMatch(/control/);
		expect(validatePrefix("a\u0000")).toMatch(/control/);
		expect(validatePrefix(5)).not.toBeNull();
	});
});

describe("stale index detection", () => {
	it("treats absent as empty and flags any difference", () => {
		expect(passagePrefixChanged(undefined, "")).toBe(false);
		expect(passagePrefixChanged("", undefined)).toBe(false);
		expect(passagePrefixChanged(undefined, "passage: ")).toBe(true);
		expect(passagePrefixChanged("passage: ", "")).toBe(true);
		expect(passagePrefixChanged("passage: ", "passage: ")).toBe(false);
	});
});
