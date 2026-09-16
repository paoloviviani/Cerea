/**
 * Staged loading: frontmatter every turn, bodies only on trigger.
 * A `@name` mention loads that body; an unknown mention is ignored;
 * nothing is ever keyword-matched.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { assembleSkillsContext, buildSkillsPreprompt, parseSkillMentions } from "./prompt";
import { createSkill, createSkillFromZip, LOAD_SKILL_FILE_TOOL_NAME } from "./service";
import { zipSync, strToU8 } from "fflate";

beforeAll(async () => {
	await ready;
}, 30000);

const owner = new ObjectId();

beforeEach(async () => {
	// Scoped to this file's owner: sibling spec files share the same test
	// database and a blanket delete would wipe a concurrently running file's
	// rows mid-test.
	await collections.skills.deleteMany({ userId: owner });
}, 20000);

describe("parseSkillMentions", () => {
	it("finds mentions in order, deduplicated", () => {
		expect(
			parseSkillMentions("please use @csv-shaping and @csv-shaping then @json-shaping")
		).toStrictEqual(["csv-shaping", "json-shaping"]);
	});

	it("ignores email addresses and prose", () => {
		expect(parseSkillMentions("write to Ada@Example.COM about it")).toStrictEqual([]);
		expect(parseSkillMentions("no mentions here")).toStrictEqual([]);
	});
});

describe("buildSkillsPreprompt", () => {
	it("is empty when there is nothing to advertise", () => {
		expect(buildSkillsPreprompt([], [])).toBeUndefined();
	});

	it("lists frontmatter, never full bodies", () => {
		const section = buildSkillsPreprompt(
			[{ name: "csv-shaping", description: "Reshape CSV.", owner: "admin" }],
			[]
		);
		expect(section).toContain("`csv-shaping`: Reshape CSV.");
		expect(section).toContain("load_skill");
		expect(section).not.toContain("# CSV shaping");
	});

	it("lists a loaded skill's bundled files, so the model knows what load_skill_file has", () => {
		const section = buildSkillsPreprompt(
			[{ name: "docx-ish", description: "Multi-file.", owner: "user" }],
			[
				{
					name: "docx-ish",
					description: "Multi-file.",
					body: "# Docx-ish\n\nUse the helper.",
					files: ["scripts/helper.py", "references/notes.md"],
				},
			]
		);
		expect(section).toContain("Bundled files");
		expect(section).toContain("scripts/helper.py");
		expect(section).toContain("references/notes.md");
		expect(section).toContain(LOAD_SKILL_FILE_TOOL_NAME);
	});

	it("says nothing about bundled files for a SKILL.md-only skill", () => {
		const section = buildSkillsPreprompt(
			[{ name: "csv-shaping", description: "Reshape CSV.", owner: "admin" }],
			[{ name: "csv-shaping", description: "Reshape CSV.", body: "# CSV shaping\n\nSteps." }]
		);
		expect(section).not.toContain("Bundled files");
	});
});

describe("assembleSkillsContext", () => {
	it("carries the frontmatter list every turn", async () => {
		const { preprompt, mentioned } = await assembleSkillsContext(owner, "hello");
		expect(preprompt).toContain("`csv-shaping`");
		expect(mentioned).toStrictEqual([]);
	});

	it("loads the body on an @name mention", async () => {
		const { preprompt, mentioned } = await assembleSkillsContext(
			owner,
			"please @csv-shaping this file"
		);
		expect(mentioned).toStrictEqual(["csv-shaping"]);
		expect(preprompt).toContain("## Skill: csv-shaping");
		expect(preprompt).toContain("# CSV shaping");
	});

	it("ignores an unknown mention silently", async () => {
		const { preprompt, mentioned } = await assembleSkillsContext(
			owner,
			"please @no-such-skill this file"
		);
		expect(mentioned).toStrictEqual([]);
		// The turn still carries the catalogue — only the body load is skipped.
		expect(preprompt).toContain("`csv-shaping`");
		expect(preprompt).not.toContain("## Skill:");
	});

	it("lists a user's enabled skill and loads it on mention", async () => {
		await createSkill(
			owner,
			`---\nname: my-skill\ndescription: Does a useful thing.\n---\n\n# My skill\n\nSteps.`
		);
		const { preprompt, mentioned } = await assembleSkillsContext(owner, "run @my-skill");
		expect(preprompt).toContain("`my-skill`: Does a useful thing.");
		expect(mentioned).toStrictEqual(["my-skill"]);
		expect(preprompt).toContain("# My skill");
	});

	it("lists bundled files when a multi-file skill's body loads on mention", async () => {
		const zip = zipSync({
			"SKILL.md": strToU8(
				`---\nname: docx-ish\ndescription: A multi-file skill.\n---\n\n# Docx-ish\n\nUse the helper.`
			),
			"scripts/helper.py": strToU8("def run():\n    return 42\n"),
		});
		await createSkillFromZip(owner, zip);
		const { preprompt } = await assembleSkillsContext(owner, "please @docx-ish this");
		expect(preprompt).toContain("## Skill: docx-ish");
		expect(preprompt).toContain("Bundled files");
		expect(preprompt).toContain("scripts/helper.py");
	});

	it("hides a user's disabled skill from both stages", async () => {
		const skill = await createSkill(
			owner,
			`---\nname: my-skill\ndescription: Does a useful thing.\n---\n\n# My skill\n\nSteps.`
		);
		const { updateSkill } = await import("./service");
		await updateSkill(owner, skill._id, { enabled: false });
		const { preprompt, mentioned } = await assembleSkillsContext(owner, "run @my-skill");
		expect(preprompt).not.toContain("my-skill");
		expect(mentioned).toStrictEqual([]);
	});
});
