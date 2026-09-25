import { describe, it, expect } from "vitest";
import { resolveActiveModel } from "./activeModel";

const MODELS = [
	{ id: "pystino/coder-large", isDefault: true },
	{ id: "pystino/coder-flash" },
	{ id: "glm-5.3-flash" },
];

describe("resolveActiveModel", () => {
	it("resolves the list's default when the session has no explicit model", () => {
		expect(resolveActiveModel(null, MODELS)).toBe(MODELS[0]);
		expect(resolveActiveModel(undefined, MODELS)).toBe(MODELS[0]);
	});

	it("resolves an explicit, provider-prefixed id", () => {
		expect(resolveActiveModel("pystino/coder-flash", MODELS)).toBe(MODELS[1]);
	});

	it("resolves an explicit, bare (non-prefixed) id", () => {
		expect(resolveActiveModel("glm-5.3-flash", MODELS)).toBe(MODELS[2]);
	});

	it("matches ids exactly: a bare id does not match its prefixed form or vice versa", () => {
		expect(resolveActiveModel("coder-flash", MODELS)).toBeUndefined();
		expect(resolveActiveModel("pystino/glm-5.3-flash", MODELS)).toBeUndefined();
	});

	it("finds nothing for an explicit model the list no longer carries — never falls back to the default", () => {
		expect(resolveActiveModel("pystino/retired-model", MODELS)).toBeUndefined();
	});

	it("finds nothing when the list has no default and the session has no explicit model", () => {
		const noDefault = [{ id: "a" }, { id: "b" }];
		expect(resolveActiveModel(null, noDefault)).toBeUndefined();
	});

	it("handles a null or missing list", () => {
		expect(resolveActiveModel("pystino/coder-large", null)).toBeUndefined();
		expect(resolveActiveModel(null, null)).toBeUndefined();
	});
});
