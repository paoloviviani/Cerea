import { describe, expect, it } from "vitest";
import { MAX_PARAM_JSON_CHARS, toPrimitive } from "./toolParams";

describe("toPrimitive: what a tool call argument becomes on the stored Call", () => {
	it("passes strings, numbers and booleans through", () => {
		expect(toPrimitive("a")).toBe("a");
		expect(toPrimitive(2)).toBe(2);
		expect(toPrimitive(false)).toBe(false);
	});

	it("keeps an object or array argument (a document spec) as JSON text instead of dropping it", () => {
		const spec = { slides: [{ layout: "blank", shapes: [{ kind: "ellipse", y_cm: -2 }] }] };
		expect(JSON.parse(toPrimitive(spec) as string)).toEqual(spec);
		expect(toPrimitive([1, 2])).toBe("[1,2]");
	});

	it("drops null and undefined", () => {
		expect(toPrimitive(null)).toBeUndefined();
		expect(toPrimitive(undefined)).toBeUndefined();
	});

	it("cuts a huge value with a visible count rather than dropping the key", () => {
		const big = { text: "x".repeat(MAX_PARAM_JSON_CHARS + 500) };
		const out = toPrimitive(big) as string;
		const full = JSON.stringify(big).length;
		expect(out.startsWith('{"text":"xxx')).toBe(true);
		expect(out.endsWith(`… (${full - MAX_PARAM_JSON_CHARS} more characters)`)).toBe(true);
	});
});
