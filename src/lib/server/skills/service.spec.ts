/**
 * User skills: stored, validated, toggleable, deletable; admin seeds
 * read-only and present. Skill content reaches the model only as prompt
 * text — never through an exec API.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	adminSkillViews,
	createSkill,
	createSkillFromZip,
	deleteSkill,
	findSkillBody,
	findSkillFile,
	includeSkillLoadBuiltin,
	listAdminSkills,
	removeSkillFile,
	resetAdminSkillCache,
	skillLoadBuiltin,
	skillLoadFileBuiltin,
	skillsAvailable,
	updateSkill,
	SkillValidationError,
	LOAD_SKILL_TOOL_NAME,
	LOAD_SKILL_FILE_TOOL_NAME,
} from "./service";
import { ADMIN_SKILL_CONTENTS } from "./adminSkills";
import { isParsedSkill, parseSkill } from "./parse";
import { zipSync, strToU8 } from "fflate";

beforeAll(async () => {
	await ready;
}, 30000);

const owner = new ObjectId();
const other = new ObjectId();

beforeEach(async () => {
	// Scoped to this file's owners: sibling spec files share the same test
	// database and a blanket delete would wipe a concurrently running file's
	// rows mid-test.
	await collections.skills.deleteMany({ userId: { $in: [owner, other] } });
}, 20000);

const VALID = `---
name: my-skill
description: Does a useful thing.
---

# My skill

Follow these steps.
`;

async function seed(content = VALID, userId = owner) {
	return createSkill(userId, content);
}

describe("validation", () => {
	it("stores a valid SKILL.md document, enabled by default", async () => {
		const skill = await seed();
		expect(skill.name).toBe("my-skill");
		expect(skill.description).toBe("Does a useful thing.");
		expect(skill.enabled).toBe(true);
		expect(skill.userId).toStrictEqual(owner);
	});

	it("rejects bad frontmatter with a reason and stores nothing", async () => {
		await expect(seed(`---\nname: no-desc\n---\n\nBody.`)).rejects.toBeInstanceOf(
			SkillValidationError
		);
		expect(await collections.skills.countDocuments({ userId: owner })).toBe(0);
	});

	it("rejects a duplicate name for the same owner", async () => {
		await seed();
		await expect(seed()).rejects.toThrow("already have a skill named `my-skill`");
	});

	it("allows two owners to hold the same name", async () => {
		await seed(VALID, owner);
		await seed(VALID, other);
		expect(await collections.skills.countDocuments({ userId: { $in: [owner, other] } })).toBe(2);
	});
});

describe("lifecycle", () => {
	it("toggles, edits, and deletes", async () => {
		const skill = await seed();
		const disabled = await updateSkill(owner, skill._id, { enabled: false });
		expect(disabled.enabled).toBe(false);

		const edited = await updateSkill(owner, skill._id, {
			content: VALID.replace("Does a useful thing.", "Does another thing."),
		});
		expect(edited.description).toBe("Does another thing.");

		expect(await deleteSkill(owner, skill._id)).toBe(true);
		expect(await collections.skills.countDocuments({ userId: owner })).toBe(0);
	});

	it("rejects an edit that collides on rename", async () => {
		await seed();
		const second = await seed(`---\nname: second\ndescription: Second skill.\n---\n\nBody.`);
		await expect(updateSkill(owner, second._id, { content: VALID })).rejects.toThrow(
			"already have a skill named `my-skill`"
		);
	});

	it("sees only its owner's rows", async () => {
		const skill = await seed(VALID, owner);
		await expect(updateSkill(other, skill._id, { enabled: false })).rejects.toThrow(
			"skill not found"
		);
		expect(await deleteSkill(other, skill._id)).toBe(false);
	});
});

describe("admin seeds", () => {
	it("ship valid SKILL.md: every seed parses", () => {
		expect(ADMIN_SKILL_CONTENTS.length).toBeGreaterThanOrEqual(2);
		for (const content of ADMIN_SKILL_CONTENTS) {
			const parsed = parseSkill(content);
			expect(isParsedSkill(parsed)).toBe(true);
		}
	});

	it("are listed read-only and present", () => {
		const seeds = listAdminSkills();
		expect(seeds.length).toBeGreaterThanOrEqual(2);
		const views = adminSkillViews();
		expect(views.every((view) => view.readOnly)).toBe(true);
		expect(views.map((view) => view.name)).toContain("csv-shaping");
	});

	it("resolve by name when no user skill matches", async () => {
		const resolved = await findSkillBody(owner, "csv-shaping");
		expect(resolved?.owner).toBe("admin");
		expect(resolved?.body).toContain("# CSV shaping");
	});
});

describe("findSkillBody", () => {
	it("prefers the user's enabled skill over a seed of the same name", async () => {
		await seed(`---\nname: csv-shaping\ndescription: Mine, not the seed.\n---\n\nMy body.`);
		const resolved = await findSkillBody(owner, "csv-shaping");
		expect(resolved?.owner).toBe("user");
		expect(resolved?.description).toBe("Mine, not the seed.");
	});

	it("skips disabled user skills and falls back to the seed", async () => {
		const skill = await seed(`---\nname: csv-shaping\ndescription: Mine.\n---\n\nMy body.`);
		await updateSkill(owner, skill._id, { enabled: false });
		expect((await findSkillBody(owner, "csv-shaping"))?.owner).toBe("admin");
	});

	it("resolves unknown names to undefined — silently, never an error", async () => {
		await expect(findSkillBody(owner, "no-such-skill")).resolves.toBeUndefined();
	});
});

describe("skillsAvailable", () => {
	it("is true on the seeds alone, with no user at all", async () => {
		await expect(skillsAvailable(undefined)).resolves.toBe(true);
		await expect(skillsAvailable(owner)).resolves.toBe(true);
	});
});

describe("includeSkillLoadBuiltin", () => {
	it("offers load_skill and load_skill_file when the seeds alone are available", async () => {
		const tools: (typeof skillLoadBuiltin)[] = [];
		expect(await includeSkillLoadBuiltin(tools, owner)).toBe(true);
		expect(tools.map((tool) => tool.name)).toStrictEqual([
			LOAD_SKILL_TOOL_NAME,
			LOAD_SKILL_FILE_TOOL_NAME,
		]);
	});

	it("offers nothing when every seed is kill-switched and the user has no skill", async () => {
		const previous = process.env.CHAT_SKILLS_DISABLED;
		// Every built-in by name — the inline seeds and the directory skills
		// alike — so the assertion stays about the kill switch, not about
		// which seeds exist.
		process.env.CHAT_SKILLS_DISABLED = listAdminSkills()
			.map((skill) => skill.name)
			.join(",");
		resetAdminSkillCache();
		try {
			const tools: (typeof skillLoadBuiltin)[] = [];
			expect(await includeSkillLoadBuiltin(tools, owner)).toBe(false);
			expect(tools).toStrictEqual([]);
		} finally {
			if (previous === undefined) delete process.env.CHAT_SKILLS_DISABLED;
			else process.env.CHAT_SKILLS_DISABLED = previous;
			resetAdminSkillCache();
		}
	});
});

describe("load_skill", () => {
	it("is named for the tool flow and takes a name", () => {
		expect(skillLoadBuiltin.name).toBe(LOAD_SKILL_TOOL_NAME);
		expect(skillLoadBuiltin.definition.function.name).toBe(LOAD_SKILL_TOOL_NAME);
	});

	it("returns the body as plain text the model reads — invoking nothing", async () => {
		await seed();
		const result = await skillLoadBuiltin.execute(
			{ name: "my-skill" },
			{ uuid: "u", toolCallId: "c", userId: owner }
		);
		// `{ resultText }` is the shape that becomes the next tool message.
		// There is no update, no park, no exec call: loading a skill reads a
		// document, and Python runs only where the model puts the procedure —
		// client-side, through the existing sandbox tools.
		expect(result).toStrictEqual({
			resultText: expect.stringContaining("# My skill"),
		});
	});

	it("answers an unknown name with a retryable error, not a failure", async () => {
		const result = await skillLoadBuiltin.execute(
			{ name: "no-such-skill" },
			{ uuid: "u", toolCallId: "c", userId: owner }
		);
		expect(result).toStrictEqual({
			error: expect.stringContaining("no enabled skill named `no-such-skill`"),
		});
	});
});

/** A minimal zip of a skill folder: `SKILL.md` at the root, plus bundled files. */
function skillZip(
	frontmatter = `---\nname: docx-ish\ndescription: A multi-file skill.\n---\n\n# Docx-ish\n\nUse the bundled helper.`,
	extra: Record<string, string> = {
		"scripts/helper.py": "def run():\n    return 42\n",
		"references/notes.md": "# Notes\n\nSome background.",
	}
): Uint8Array {
	const entries: Record<string, Uint8Array> = { "SKILL.md": strToU8(frontmatter) };
	for (const [path, content] of Object.entries(extra)) entries[path] = strToU8(content);
	return zipSync(entries);
}

describe("createSkillFromZip", () => {
	it("imports SKILL.md plus scripts/ and references/, path-validated", async () => {
		const skill = await createSkillFromZip(owner, skillZip());
		expect(skill.name).toBe("docx-ish");
		expect(skill.files?.map((file) => file.path).sort()).toStrictEqual([
			"references/notes.md",
			"scripts/helper.py",
		]);
		expect(skill.files?.find((file) => file.path === "scripts/helper.py")?.content).toContain(
			"def run()"
		);
	});

	it("also imports a skill folder wrapped in one directory", async () => {
		const wrapped = zipSync({
			"my-skill/SKILL.md": strToU8(
				`---\nname: wrapped-skill\ndescription: Wrapped in a folder.\n---\n\nBody.`
			),
			"my-skill/scripts/tool.py": strToU8("print('hi')\n"),
		});
		const skill = await createSkillFromZip(owner, wrapped);
		expect(skill.name).toBe("wrapped-skill");
		expect(skill.files?.map((file) => file.path)).toStrictEqual(["scripts/tool.py"]);
	});

	it("stores a binary asset as base64", async () => {
		const binary = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0xfe, 0x00, 0x01]);
		const zip = zipSync({
			"SKILL.md": strToU8(
				`---\nname: asset-skill\ndescription: Ships a binary asset.\n---\n\nBody.`
			),
			"assets/logo.bin": binary,
		});
		const skill = await createSkillFromZip(owner, zip);
		const file = skill.files?.find((f) => f.path === "assets/logo.bin");
		expect(file?.encoding).toBe("base64");
		expect(Buffer.from(file?.content ?? "", "base64")).toStrictEqual(Buffer.from(binary));
	});

	it("drops a root file outside scripts/references/assets rather than rejecting the import", async () => {
		// Real skill folders ship more than the three bundled directories —
		// the anthropics skills repo puts a LICENSE.txt beside every SKILL.md.
		const zip = zipSync({
			"SKILL.md": strToU8(
				`---\nname: licensed-skill\ndescription: Ships a license file.\n---\n\nBody.`
			),
			"LICENSE.txt": strToU8("MIT License\n"),
			"scripts/tool.py": strToU8("print('ok')\n"),
		});
		const skill = await createSkillFromZip(owner, zip);
		expect(skill.files?.map((file) => file.path)).toStrictEqual(["scripts/tool.py"]);
	});

	it("rejects a path that escapes the skill folder with ..", async () => {
		const zip = zipSync({
			"SKILL.md": strToU8(`---\nname: escape-skill\ndescription: Escaping.\n---\n\nBody.`),
			"scripts/../../etc/passwd": strToU8("nope"),
		});
		await expect(createSkillFromZip(owner, zip)).rejects.toBeInstanceOf(SkillValidationError);
	});

	it("rejects a zip with no SKILL.md", async () => {
		const zip = zipSync({ "scripts/tool.py": strToU8("print(1)\n") });
		await expect(createSkillFromZip(owner, zip)).rejects.toBeInstanceOf(SkillValidationError);
	});

	it("still rejects bad frontmatter inside the zip, like the plain-text path", async () => {
		const zip = zipSync({ "SKILL.md": strToU8(`---\nname: no-desc\n---\n\nBody.`) });
		await expect(createSkillFromZip(owner, zip)).rejects.toBeInstanceOf(SkillValidationError);
	});

	it("skips macOS zip junk (__MACOSX, .DS_Store) rather than rejecting the import", async () => {
		const zip = zipSync({
			"SKILL.md": strToU8(`---\nname: mac-skill\ndescription: From a Mac.\n---\n\nBody.`),
			"scripts/tool.py": strToU8("print(1)\n"),
			".DS_Store": strToU8("junk"),
			"__MACOSX/scripts/._tool.py": strToU8("junk"),
		});
		const skill = await createSkillFromZip(owner, zip);
		expect(skill.files?.map((file) => file.path)).toStrictEqual(["scripts/tool.py"]);
	});
});

describe("findSkillFile and load_skill_file", () => {
	it("resolves a bundled file's content by skill name and path", async () => {
		await createSkillFromZip(owner, skillZip());
		const file = await findSkillFile(owner, "docx-ish", "scripts/helper.py");
		expect(file?.content).toContain("def run()");
	});

	it("resolves an unknown skill or an unknown path to undefined — silently", async () => {
		await createSkillFromZip(owner, skillZip());
		expect(await findSkillFile(owner, "no-such-skill", "scripts/helper.py")).toBeUndefined();
		expect(await findSkillFile(owner, "docx-ish", "scripts/no-such-file.py")).toBeUndefined();
	});

	it("the load_skill_file tool returns the file's text, invoking nothing", async () => {
		await createSkillFromZip(owner, skillZip());
		const result = await skillLoadFileBuiltin.execute(
			{ skill: "docx-ish", path: "scripts/helper.py" },
			{ uuid: "u", toolCallId: "c", userId: owner }
		);
		expect(result).toStrictEqual({ resultText: expect.stringContaining("def run()") });
	});

	it("the load_skill_file tool answers an unknown file with a retryable error, not a failure", async () => {
		await createSkillFromZip(owner, skillZip());
		const result = await skillLoadFileBuiltin.execute(
			{ skill: "docx-ish", path: "scripts/absent.py" },
			{ uuid: "u", toolCallId: "c", userId: owner }
		);
		expect(result).toStrictEqual({ error: expect.stringContaining("No bundled file") });
	});

	it("load_skill's result lists the bundled files so the model knows what it can load", async () => {
		await createSkillFromZip(owner, skillZip());
		const result = await skillLoadBuiltin.execute(
			{ name: "docx-ish" },
			{ uuid: "u", toolCallId: "c", userId: owner }
		);
		expect(result).toStrictEqual({
			resultText: expect.stringContaining("scripts/helper.py"),
		});
	});
});

describe("removeSkillFile", () => {
	it("drops one bundled file, leaving the rest and the body untouched", async () => {
		const skill = await createSkillFromZip(owner, skillZip());
		const updated = await removeSkillFile(owner, skill._id, "scripts/helper.py");
		expect(updated.files?.map((file) => file.path)).toStrictEqual(["references/notes.md"]);
		expect(updated.content).toContain("# Docx-ish");
	});

	it("sees only its owner's rows", async () => {
		const skill = await createSkillFromZip(owner, skillZip());
		await expect(removeSkillFile(other, skill._id, "scripts/helper.py")).rejects.toThrow(
			"skill not found"
		);
	});
});
