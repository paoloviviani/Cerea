import { describe, expect, it } from "vitest";
import { filterPalette, MAX_RESULTS, scoreItem, type PaletteItem } from "./commandPalette";

const item = (kind: PaletteItem["kind"], label: string, detail?: string): PaletteItem => ({
	key: `${kind}:${label}`,
	kind,
	label,
	detail,
	href: `/${label}`,
});

describe("scoreItem", () => {
	it("ranks prefix over word start over substring, ignoring case and accents", () => {
		const prefix = scoreItem(item("chat", "Budget 2027"), "bud");
		const word = scoreItem(item("chat", "The Budget"), "bud");
		const inside = scoreItem(item("chat", "Rebuddy"), "bud");
		expect(prefix).toBeGreaterThan(word);
		expect(word).toBeGreaterThan(inside);
		expect(inside).toBeGreaterThan(0);
		expect(scoreItem(item("chat", "Caffè"), "CAFFE")).toBeGreaterThan(0);
	});

	it("matches every word of a longer query across label and detail, and the detail alone weakly", () => {
		const session = item("agent", "Fix flaky test", "Build box › cerea");
		expect(scoreItem(session, "flaky cerea")).toBeGreaterThan(0);
		expect(scoreItem(session, "flaky nope")).toBe(0);
		expect(scoreItem(session, "build box")).toBeGreaterThan(0);
		expect(scoreItem(session, "build box")).toBeLessThan(scoreItem(session, "fix"));
	});

	it("matches nothing for a query that is not there", () => {
		expect(scoreItem(item("page", "Settings"), "zzz")).toBe(0);
	});
});

describe("filterPalette", () => {
	const items = [
		...Array.from({ length: 10 }, (_, i) => item("chat", `chat ${i}`)),
		item("page", "Settings"),
		item("project", "Budget 2027"),
		item("schedule", "Weekly report"),
		item("agent", "Budget session", "Box"),
	];

	it("shows a short list per kind, pages first, when nothing is typed", () => {
		const shown = filterPalette(items, "  ");
		expect(shown.map((i) => i.kind)).toEqual([
			"page",
			"chat",
			"chat",
			"chat",
			"chat",
			"chat",
			"chat",
			"project",
			"agent",
			"schedule",
		]);
		// The caller's order inside a kind is the recency order: it is kept.
		expect(shown.filter((i) => i.kind === "chat")[0]?.label).toBe("chat 0");
	});

	it("returns matches best first across kinds", () => {
		const shown = filterPalette(items, "budget");
		expect(shown.map((i) => i.label)).toEqual(["Budget 2027", "Budget session"]);
	});

	it("caps the list", () => {
		const many = Array.from({ length: MAX_RESULTS + 20 }, (_, i) => item("chat", `note ${i}`));
		expect(filterPalette(many, "note")).toHaveLength(MAX_RESULTS);
	});
});
