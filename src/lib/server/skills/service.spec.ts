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
	deleteSkill,
	findSkillBody,
	includeSkillLoadBuiltin,
	listAdminSkills,
	resetAdminSkillCache,
	skillLoadBuiltin,
	skillsAvailable,
	updateSkill,
	SkillValidationError,
	LOAD_SKILL_TOOL_NAME,
} from "./service";
import { ADMIN_SKILL_CONTENTS } from "./adminSkills";
import { isParsedSkill, parseSkill } from "./parse";

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
	it("offers load_skill when the seeds alone are available", async () => {
		const tools: (typeof skillLoadBuiltin)[] = [];
		expect(await includeSkillLoadBuiltin(tools, owner)).toBe(true);
		expect(tools.map((tool) => tool.name)).toStrictEqual([LOAD_SKILL_TOOL_NAME]);
	});

	it("offers nothing when every seed is kill-switched and the user has no skill", async () => {
		const previous = process.env.CHAT_SKILLS_DISABLED;
		process.env.CHAT_SKILLS_DISABLED = "csv-shaping,report-writing,json-shaping";
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
