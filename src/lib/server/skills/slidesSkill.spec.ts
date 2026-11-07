/**
 * The slides skill (ADR 0111) names themes, fonts and layouts the renderer
 * implements; this keeps the two in step, and checks the routing against the
 * powerpoint skill is stated on both sides.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseSkill, isParsedSkill } from "./parse";
import { parseDeck } from "$lib/utils/slides/deck";
import { THEME_IDS } from "$lib/utils/slides/themes";

const dir = new URL("./builtin/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, dir), "utf8");
const skill = read("slides/SKILL.md");
const powerpoint = read("powerpoint/SKILL.md");

describe("slides skill", () => {
	it("parses and names itself", () => {
		const parsed = parseSkill(skill);
		expect(isParsedSkill(parsed)).toBe(true);
		if (isParsedSkill(parsed)) expect(parsed.name).toBe("slides");
	});

	it("names every theme and the brand variables the renderer defines", () => {
		for (const id of THEME_IDS) expect(skill).toContain(`\`${id}\``);
		for (const name of ["--brand-accent", "--brand-font", "--brand-logo-url"]) {
			expect(skill).toContain(name);
		}
	});

	it("teaches sections and notes, not layout classes", () => {
		expect(skill).toContain("<section>");
		expect(skill).toContain('<aside class="notes">');
		expect(skill).not.toMatch(/two-columns|big-number|image-left/);
	});

	it("ships a designed example deck and a Markdown example that both parse", () => {
		const html = parseDeck(read("slides/references/example-deck.html"));
		expect(html.mode).toBe("html");
		expect(html.slideCount).toBeGreaterThanOrEqual(5);
		expect(html.stripped.scripts).toBe(0);
		const md = parseDeck(read("slides/references/example-markdown.md"));
		expect(md.mode).toBe("markdown");
		expect(md.meta.theme).toBe("cerea");
	});

	it("keeps the shipped example identical to the test fixture", () => {
		const fixture = readFileSync(
			new URL("../../utils/slides/fixtures/talk-deck.html", import.meta.url),
			"utf8"
		);
		expect(read("slides/references/example-deck.html")).toBe(fixture);
	});

	it("routes with the question card, with the skip rules, on both skills", () => {
		for (const raw of [skill, powerpoint]) {
			const text = raw.replace(/\s+/g, " ");
			expect(text).toContain("ask_user_question");
			expect(text).toContain("Slides to present or share here");
			expect(text).toContain("A PowerPoint file to edit");
			expect(text).toMatch(/pptx/);
			expect(text).toMatch(/not in the Available skills list/);
		}
		expect(skill).toContain("just slides");
	});

	it("keeps each description pointing at the other skill", () => {
		const desc = (t: string) => /description:\s*>\n([\s\S]*?)\n---/.exec(t)?.[1] ?? "";
		expect(desc(skill)).toMatch(/powerpoint/i);
		expect(desc(powerpoint)).toMatch(/slides skill/i);
	});
});
