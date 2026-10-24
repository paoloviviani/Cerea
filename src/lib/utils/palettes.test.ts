import { describe, expect, it } from "vitest";
import {
	ACCENTS,
	NEUTRALS,
	applyPalette,
	paletteAttributes,
	parseAccent,
	parseNeutral,
} from "./palettes";

describe("palette values", () => {
	it("offers the six accents and three tones, blue and neutral first", () => {
		expect([...ACCENTS]).toEqual(["blue", "violet", "teal", "green", "rose", "orange"]);
		expect([...NEUTRALS]).toEqual(["neutral", "cool", "warm"]);
	});

	it("parses only the fixed lists", () => {
		expect(parseAccent("teal")).toBe("teal");
		expect(parseNeutral("warm")).toBe("warm");
		for (const bad of ["Teal", "red", "", null, undefined, 3, {}, "teal ", "__proto__"]) {
			expect(parseAccent(bad)).toBeUndefined();
			expect(parseNeutral(bad)).toBeUndefined();
		}
		// Each list's values are not the other's.
		expect(parseAccent("cool")).toBeUndefined();
		expect(parseNeutral("teal")).toBeUndefined();
	});
});

describe("old tone ids", () => {
	it("read as the tone that replaced them", () => {
		expect(parseNeutral("gray")).toBe("neutral");
		expect(parseNeutral("slate")).toBe("cool");
		expect(parseNeutral("stone")).toBe("warm");
		expect(parseNeutral("constructor")).toBeUndefined();
		expect(paletteAttributes({ neutral: "slate" })).toBe('data-neutral="cool"');
		expect(paletteAttributes({ neutral: "stone" })).toBe('data-neutral="warm"');
		expect(paletteAttributes({ neutral: "neutral" })).toBe("");
	});
});

describe("paletteAttributes", () => {
	it("is empty for the defaults, absent and unknown values", () => {
		expect(paletteAttributes({})).toBe("");
		expect(paletteAttributes({ accent: "blue", neutral: "neutral" })).toBe("");
		expect(paletteAttributes({ accent: "chartreuse", neutral: 7 })).toBe("");
	});

	it("emits just the attributes that differ", () => {
		expect(paletteAttributes({ accent: "teal" })).toBe('data-accent="teal"');
		expect(paletteAttributes({ neutral: "cool" })).toBe('data-neutral="cool"');
		expect(paletteAttributes({ accent: "violet", neutral: "warm" })).toBe(
			'data-accent="violet" data-neutral="warm"'
		);
	});

	it("can only ever emit a value from the fixed lists, so it cannot inject markup", () => {
		expect(paletteAttributes({ accent: 'teal" onload="x' })).toBe("");
	});
});

describe("applyPalette", () => {
	const element = () => {
		const attrs = new Map<string, string>();
		return {
			attrs,
			setAttribute: (k: string, v: string) => void attrs.set(k, v),
			removeAttribute: (k: string) => void attrs.delete(k),
		};
	};

	it("sets, changes and removes the attributes, treating the defaults as none", () => {
		const el = element();
		applyPalette(el as unknown as HTMLElement, { accent: "teal", neutral: "warm" });
		expect([...el.attrs]).toEqual([
			["data-accent", "teal"],
			["data-neutral", "warm"],
		]);
		applyPalette(el as unknown as HTMLElement, { accent: "rose", neutral: "neutral" });
		expect([...el.attrs]).toEqual([["data-accent", "rose"]]);
		applyPalette(el as unknown as HTMLElement, { accent: "blue" });
		expect(el.attrs.size).toBe(0);
	});
});
