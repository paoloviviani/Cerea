import { describe, expect, it } from "vitest";
import { isParsedSkill, parseSkill, SKILL_MAX_BODY_LINES, splitFrontmatter } from "./parse";

const VALID = `---
name: csv-shaping
description: Reshape CSV data with the csv module.
---

# CSV shaping

Do the thing.
`;

describe("parseSkill", () => {
	it("accepts a valid SKILL.md document", () => {
		const parsed = parseSkill(VALID);
		expect(isParsedSkill(parsed)).toBe(true);
		if (!isParsedSkill(parsed)) return;
		expect(parsed.name).toBe("csv-shaping");
		expect(parsed.description).toBe("Reshape CSV data with the csv module.");
		expect(parsed.body).toContain("# CSV shaping");
		expect(parsed.body).not.toContain("---");
		expect(parsed.truncated).toBe(false);
	});

	it("rejects a document with no frontmatter, with a logged reason", () => {
		const parsed = parseSkill("# Just markdown\n\nNo frontmatter here.");
		expect(isParsedSkill(parsed)).toBe(false);
		if (isParsedSkill(parsed)) return;
		expect(parsed.reason).toContain("frontmatter");
	});

	it("rejects a missing name", () => {
		const parsed = parseSkill(`---\ndescription: Has no name.\n---\n\nBody.`);
		expect(isParsedSkill(parsed)).toBe(false);
		if (isParsedSkill(parsed)) return;
		expect(parsed.reason).toContain("name");
	});

	it("rejects a missing description", () => {
		const parsed = parseSkill(`---\nname: no-desc\n---\n\nBody.`);
		expect(isParsedSkill(parsed)).toBe(false);
		if (isParsedSkill(parsed)) return;
		expect(parsed.reason).toContain("description");
	});

	it("rejects invalid YAML frontmatter", () => {
		const parsed = parseSkill(`---\nname: [unclosed\n---\n\nBody.`);
		expect(isParsedSkill(parsed)).toBe(false);
	});

	it("rejects names outside the open naming rule", () => {
		for (const name of ["Has_Spaces", "UPPER", "with/slash", "with.dot"]) {
			const parsed = parseSkill(`---\nname: ${name}\ndescription: d.\n---\n\nBody.`);
			expect(isParsedSkill(parsed)).toBe(false);
		}
	});

	it("truncates a body past 500 lines instead of rejecting it", () => {
		const body = Array.from({ length: SKILL_MAX_BODY_LINES + 50 }, (_, i) => `line ${i}`).join(
			"\n"
		);
		const parsed = parseSkill(
			`---\nname: long-skill\ndescription: A very long skill.\n---\n\n${body}`
		);
		expect(isParsedSkill(parsed)).toBe(true);
		if (!isParsedSkill(parsed)) return;
		expect(parsed.truncated).toBe(true);
		expect(parsed.body.split("\n")).toHaveLength(SKILL_MAX_BODY_LINES);
	});
});

describe("splitFrontmatter", () => {
	it("returns undefined without an opening fence", () => {
		expect(splitFrontmatter("no fence")).toBeUndefined();
	});
});
