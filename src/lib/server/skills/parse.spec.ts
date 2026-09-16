import { describe, expect, it } from "vitest";
import {
	invalidSkillFilePathReason,
	isParsedSkill,
	parseSkill,
	SKILL_MAX_BODY_LINES,
	SKILL_MAX_FILE_BYTES,
	SKILL_MAX_FILE_COUNT,
	SKILL_MAX_TOTAL_FILE_BYTES,
	splitFrontmatter,
	validateSkillFiles,
} from "./parse";

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

describe("invalidSkillFilePathReason", () => {
	it("accepts paths under scripts/, references/ and assets/", () => {
		for (const path of ["scripts/tool.py", "references/notes.md", "assets/logo.png"]) {
			expect(invalidSkillFilePathReason(path)).toBeUndefined();
		}
	});

	it("accepts a nested path under an allowed prefix", () => {
		expect(invalidSkillFilePathReason("scripts/lib/helpers.py")).toBeUndefined();
	});

	it("rejects a path outside the three directories", () => {
		expect(invalidSkillFilePathReason("setup.py")).toContain("scripts/, references/ or assets/");
	});

	it("rejects a path that escapes with ..", () => {
		expect(invalidSkillFilePathReason("scripts/../../etc/passwd")).toContain("..");
	});

	it("rejects a path with a . segment", () => {
		expect(invalidSkillFilePathReason("scripts/./tool.py")).toContain(".");
	});

	it("rejects an absolute path", () => {
		expect(invalidSkillFilePathReason("/etc/passwd")).toContain("relative");
	});

	it("rejects backslashes", () => {
		expect(invalidSkillFilePathReason("scripts\\tool.py")).toContain("forward slashes");
	});

	it("rejects a directory (trailing slash)", () => {
		expect(invalidSkillFilePathReason("scripts/")).toContain("not a directory");
	});

	it("rejects an empty path", () => {
		expect(invalidSkillFilePathReason("")).toContain("non-empty");
	});
});

describe("validateSkillFiles", () => {
	function file(path: string, text: string) {
		return { path, data: new TextEncoder().encode(text) };
	}

	it("accepts valid files, encoding text as-is", () => {
		const result = validateSkillFiles([file("scripts/tool.py", "print(1)\n")]);
		expect(Array.isArray(result)).toBe(true);
		if (!Array.isArray(result)) return;
		expect(result).toStrictEqual([{ path: "scripts/tool.py", content: "print(1)\n" }]);
	});

	it("base64-encodes bytes that do not round-trip through UTF-8", () => {
		const binary = new Uint8Array([0xff, 0xfe, 0x00, 0xff]);
		const result = validateSkillFiles([{ path: "assets/logo.bin", data: binary }]);
		expect(Array.isArray(result)).toBe(true);
		if (!Array.isArray(result)) return;
		expect(result[0]?.encoding).toBe("base64");
		expect(Buffer.from(result[0]?.content ?? "", "base64")).toStrictEqual(Buffer.from(binary));
	});

	it("rejects the whole set on one bad path, naming it", () => {
		const result = validateSkillFiles([file("scripts/ok.py", "1"), file("bad.py", "2")]);
		expect(Array.isArray(result)).toBe(false);
		if (Array.isArray(result)) return;
		expect(result.reason).toContain("bad.py");
	});

	it("rejects a single file over the per-file cap", () => {
		const big = "a".repeat(SKILL_MAX_FILE_BYTES + 1);
		const result = validateSkillFiles([file("scripts/big.py", big)]);
		expect(Array.isArray(result)).toBe(false);
	});

	it("rejects a set over the total cap even when each file is under the per-file cap", () => {
		const chunk = "a".repeat(SKILL_MAX_FILE_BYTES);
		const files = Array.from(
			{ length: Math.ceil(SKILL_MAX_TOTAL_FILE_BYTES / chunk.length) + 1 },
			(_, i) => file(`scripts/f${i}.py`, chunk)
		);
		const result = validateSkillFiles(files);
		expect(Array.isArray(result)).toBe(false);
	});

	it("rejects more than the per-skill file count", () => {
		const files = Array.from({ length: SKILL_MAX_FILE_COUNT + 1 }, (_, i) =>
			file(`scripts/f${i}.py`, "x")
		);
		const result = validateSkillFiles(files);
		expect(Array.isArray(result)).toBe(false);
	});
});
