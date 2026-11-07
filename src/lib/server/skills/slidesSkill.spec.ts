/**
 * The slides skill (ADR 0111) names themes, fonts and layouts the renderer
 * implements; this keeps the two in step, and checks the routing against the
 * powerpoint skill is stated on both sides.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseSkill, isParsedSkill } from "./parse";
import { parseDeck } from "$lib/utils/slides/deck";
import { FONT_IDS, THEME_IDS } from "$lib/utils/slides/themes";

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

	it("lists every theme and font the renderer accepts", () => {
		for (const id of THEME_IDS) expect(skill).toContain(`\`${id}\``);
		for (const id of FONT_IDS) expect(skill).toContain(`\`${id}\``);
	});

	it("documents every layout class that slides.css defines", () => {
		const css = readFileSync(new URL("../../utils/slides/slides.css", import.meta.url), "utf8");
		const layouts = [
			"title",
			"section",
			"two-columns",
			"image-left",
			"image-right",
			"quote",
			"big-number",
		];
		for (const name of layouts) {
			expect(css).toContain(`section.${name}`);
			expect(skill).toContain(`\`${name}\``);
		}
	});

	it("ships an example deck that parses with a known theme", () => {
		const deck = parseDeck(read("slides/references/example-deck.md"));
		expect(deck.meta.theme).toBe("cerea");
		expect(deck.slideCount).toBeGreaterThanOrEqual(6);
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
