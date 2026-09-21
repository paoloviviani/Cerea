/**
 * Deployment-scope skills: the same collection with a scope flag, managed by
 * administrators and readable by everybody (ADR 0072 amendment).
 *
 * Seeds become bootstrap — the three code definitions are inserted as rows
 * on first read, manageable thereafter, never duplicated — and user skills
 * keep owner scope exactly as before.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	createDeploymentSkill,
	createSkill,
	deleteDeploymentSkill,
	ensureDeploymentSeeds,
	findSkillBody,
	listDeploymentSkills,
	listEnabledUserSkills,
	listUserSkills,
	resetAdminSkillCache,
	resetSeedEnsured,
	updateDeploymentSkill,
	SkillValidationError,
} from "./service";

beforeAll(async () => {
	await ready;
}, 30000);

const admin = new ObjectId();
const owner = new ObjectId();
const stranger = new ObjectId();

/** Deployment rows this file created, named distinctly from the seeds. */
const created: ObjectId[] = [];

function doc(name = "admin-spec-skill", description = "Deployment procedure.") {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# Procedure\n\nSteps.`;
}

async function seedDeployment(name = "admin-spec-skill") {
	const skill = await createDeploymentSkill(admin, doc(name));
	created.push(skill._id);
	return skill;
}

beforeEach(async () => {
	resetSeedEnsured();
	await collections.skills.deleteMany({ userId: { $in: [owner, stranger] } });
}, 20000);

afterEach(async () => {
	await collections.skills.deleteMany({ _id: { $in: created } });
	created.length = 0;
	const previous = process.env.CHAT_SKILLS_DISABLED;
	if (previous === undefined) delete process.env.CHAT_SKILLS_DISABLED;
	else process.env.CHAT_SKILLS_DISABLED = previous;
	resetAdminSkillCache();
	resetSeedEnsured();
});

describe("seed bootstrap", () => {
	it("inserts the three code seeds as deployment rows on first read, once", async () => {
		await ensureDeploymentSeeds();
		const first = await listDeploymentSkills();
		expect(first.map((row) => row.name)).toEqual(
			expect.arrayContaining(["csv-shaping", "report-writing", "json-shaping"])
		);
		await ensureDeploymentSeeds();
		const second = await listDeploymentSkills();
		for (const name of ["csv-shaping", "report-writing", "json-shaping"]) {
			expect(second.filter((row) => row.name === name)).toHaveLength(1);
		}
	});

	it("never overwrites an edited seed row", async () => {
		await ensureDeploymentSeeds();
		const seed = await collections.skills.findOne({ scope: "deployment", name: "csv-shaping" });
		if (!seed) throw new Error("expected the csv-shaping seed row after bootstrap");
		const seedId = seed._id;
		const seedDescription = seed.description;
		await collections.skills.updateOne(
			{ _id: seedId },
			{ $set: { description: "Edited by an administrator." } }
		);
		resetSeedEnsured();
		try {
			await ensureDeploymentSeeds();
			const kept = await collections.skills.findOne({ scope: "deployment", name: "csv-shaping" });
			expect(kept?.description).toBe("Edited by an administrator.");
		} finally {
			await collections.skills.updateOne(
				{ _id: seedId },
				{ $set: { description: seedDescription } }
			);
		}
	});
});

describe("deployment lifecycle", () => {
	it("creates, disables, edits, and deletes a built-in skill", async () => {
		const skill = await seedDeployment();
		expect(skill.scope).toBe("deployment");
		expect(skill.enabled).toBe(true);

		const disabled = await updateDeploymentSkill(skill._id, { enabled: false });
		expect(disabled.enabled).toBe(false);

		const edited = await updateDeploymentSkill(skill._id, {
			content: doc("admin-spec-skill", "New description."),
		});
		expect(edited.description).toBe("New description.");

		expect(await deleteDeploymentSkill(skill._id)).toBe(true);
		created.length = 0;
		expect(await collections.skills.countDocuments({ _id: skill._id, scope: "deployment" })).toBe(
			0
		);
	});

	it("rejects bad frontmatter with a reason and stores nothing — like user skills", async () => {
		const before = await collections.skills.countDocuments({ scope: "deployment" });
		await expect(
			createDeploymentSkill(admin, `---\nname: no-desc\n---\n\nBody.`)
		).rejects.toBeInstanceOf(SkillValidationError);
		expect(await collections.skills.countDocuments({ scope: "deployment" })).toBe(before);
	});

	it("rejects a duplicate deployment name", async () => {
		await seedDeployment("admin-spec-dup");
		await expect(seedDeployment("admin-spec-dup")).rejects.toThrow(
			"already a built-in skill named `admin-spec-dup`"
		);
	});

	it("rejects an edit that collides on rename", async () => {
		await seedDeployment("admin-spec-first");
		const second = await seedDeployment("admin-spec-second");
		await expect(
			updateDeploymentSkill(second._id, { content: doc("admin-spec-first") })
		).rejects.toThrow("already a built-in skill named `admin-spec-first`");
	});
});

describe("scope separation", () => {
	it("leaves user skills untouched: owner listings exclude deployment rows", async () => {
		await createSkill(owner, doc("my-skill", "Mine."));
		await seedDeployment("admin-spec-other");
		expect((await listUserSkills(owner)).map((row) => row.name)).toStrictEqual(["my-skill"]);
		expect((await listEnabledUserSkills(owner)).map((row) => row.name)).toStrictEqual(["my-skill"]);
	});

	it("lets two owners share a name with a deployment row: the user's own wins", async () => {
		await createSkill(owner, doc("admin-spec-shared", "Mine, not the deployment's."));
		await seedDeployment("admin-spec-shared");
		const resolved = await findSkillBody(owner, "admin-spec-shared");
		expect(resolved?.owner).toBe("user");
		expect((await findSkillBody(stranger, "admin-spec-shared"))?.owner).toBe("admin");
	});

	it("lets one owner hold the same name as user and deployment rows", async () => {
		// The operator's bug: a deployment row stores its creating admin's
		// userId, so under a {userId, name} unique key an admin importing a
		// deployment skill named like one of their own user skills hit a
		// duplicate key. The key is {scope, userId, name}; both orders work.
		await createSkill(admin, doc("admin-spec-self", "Mine."));
		try {
			const deployed = await createDeploymentSkill(admin, doc("admin-spec-self", "Everyone's."));
			created.push(deployed._id);
			expect((await listUserSkills(admin)).map((row) => row.name)).toStrictEqual([
				"admin-spec-self",
			]);
			expect((await findSkillBody(admin, "admin-spec-self"))?.owner).toBe("user");
			expect((await findSkillBody(stranger, "admin-spec-self"))?.owner).toBe("admin");
		} finally {
			// Both rows share this owner and name (different scopes); the
			// afterEach cleanup of `created` then finds nothing left.
			await collections.skills.deleteMany({ userId: admin, name: "admin-spec-self" });
		}
	});

	it("lets one owner import the user row after the deployment row", async () => {
		const deployed = await createDeploymentSkill(admin, doc("admin-spec-self-rev", "Everyone's."));
		created.push(deployed._id);
		try {
			await createSkill(admin, doc("admin-spec-self-rev", "Mine."));
			expect((await findSkillBody(admin, "admin-spec-self-rev"))?.owner).toBe("user");
		} finally {
			await collections.skills.deleteMany({ userId: admin, name: "admin-spec-self-rev" });
		}
	});
});

describe("deployment resolution", () => {
	it("resolves a deployment row for a user with no skills of their own", async () => {
		await seedDeployment("admin-spec-resolve");
		const resolved = await findSkillBody(stranger, "admin-spec-resolve");
		expect(resolved?.owner).toBe("admin");
		expect(resolved?.body).toContain("# Procedure");
	});

	it("a disabled deployment row resolves to nothing — disabling is a toggle", async () => {
		const skill = await seedDeployment("admin-spec-toggle");
		expect(await findSkillBody(stranger, "admin-spec-toggle")).toBeDefined();
		await updateDeploymentSkill(skill._id, { enabled: false });
		expect(await findSkillBody(stranger, "admin-spec-toggle")).toBeUndefined();
	});

	it("the kill-switch filters deployment rows by name regardless of source", async () => {
		await seedDeployment("admin-spec-killed");
		process.env.CHAT_SKILLS_DISABLED = "admin-spec-killed";
		resetAdminSkillCache();
		expect(await findSkillBody(stranger, "admin-spec-killed")).toBeUndefined();
		expect((await listDeploymentSkills()).some((row) => row.name === "admin-spec-killed")).toBe(
			false
		);
	});
});
