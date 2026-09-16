/**
 * Staged loading: frontmatter every turn, bodies only on trigger.
 * A `@name` mention loads that body; an unknown mention is ignored;
 * nothing is ever keyword-matched.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { assembleSkillsContext, buildSkillsPreprompt, parseSkillMentions } from "./prompt";
import { createSkill } from "./service";

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
