import { describe, expect, it } from "vitest";
import {
	BLURB_MAX,
	compareConnectors,
	connectorBlurb,
	localServerLabel,
	stripMarkdown,
	truncateWords,
} from "./connectorBlurb";

describe("stripMarkdown", () => {
	it("removes headings, emphasis, code, links, lists and tags", () => {
		expect(
			stripMarkdown(
				"# Search for flights\n\nSearches **Kiwi.com** for `cheap` [flights](http://x)."
			)
		).toBe("Search for flights Searches Kiwi.com for cheap flights.");
		expect(stripMarkdown("- one\n- two\n1. three <b>x</b>")).toBe("one two three x");
	});
});

describe("truncateWords", () => {
	it("leaves short text alone and cuts long text on a word with an ellipsis", () => {
		expect(truncateWords("short text")).toBe("short text");
		const long = "word ".repeat(80).trim();
		const out = truncateWords(long);
		expect(out.length).toBeLessThanOrEqual(BLURB_MAX);
		expect(out.endsWith("word…")).toBe(true);
	});
	it("never cuts mid-word", () => {
		const out = truncateWords("alpha beta gamma delta epsilon", 20);
		expect(out).toBe("alpha beta gamma…");
	});
});

describe("connectorBlurb", () => {
	it("takes the first source that has text, as plain words", () => {
		expect(connectorBlurb(undefined, "", "**Issues** and boards")).toBe("Issues and boards");
	});
	it("is empty when the connector has no description of its own (never a tool's)", () => {
		expect(connectorBlurb(undefined, null, "  ")).toBe("");
		expect(connectorBlurb()).toBe("");
	});
});

describe("localServerLabel", () => {
	it("uses a name-like description as the title and keeps the id as secondary text", () => {
		expect(localServerLabel("calendar", "Infomaniak Calendar")).toEqual({
			title: "Infomaniak Calendar",
			detail: "calendar",
			blurb: "",
		});
	});
	it("keeps the id as the title and a real description as the line", () => {
		const out = localServerLabel(
			"notes",
			"Reads and writes the notes kept in the vault on this machine."
		);
		expect(out.title).toBe("notes");
		expect(out.blurb).toContain("Reads and writes");
		expect(out.detail).toBeUndefined();
	});
	it("handles no description", () => {
		expect(localServerLabel("ikmail", undefined)).toEqual({ title: "ikmail", blurb: "" });
	});
});

describe("compareConnectors", () => {
	it("sorts alphabetically by display name, ignoring case", () => {
		const names = ["kiwi", "Draw.io", "Infomaniak Calendar", "GitHub"].map((name) => ({ name }));
		expect(names.sort(compareConnectors).map((n) => n.name)).toEqual([
			"Draw.io",
			"GitHub",
			"Infomaniak Calendar",
			"kiwi",
		]);
	});
});
