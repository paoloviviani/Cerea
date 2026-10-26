/**
 * Built-in skills: the directory-based definitions, bundled files, and the
 * seedHash upgrade rule.
 *
 * Seeds are bootstrap; the upgrade is bounded by what the row says about
 * itself. These specs craft rows directly (an older definition with its
 * matching hash; an edited one; a legacy row without a hash) and hold the
 * rule to its promises: an unedited row upgrades, an edited row is never
 * touched, and the enabled toggle survives every path.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import type { Skill } from "$lib/types/Skill";
import { builtinSkillHash, listBuiltinSkills, resetBuiltinSkillCache } from "./builtinSkills";
import {
	ensureDeploymentSeeds,
	findSkillBody,
	findSkillFile,
	listAdminSkills,
	listDeploymentSkills,
	resetAdminSkillCache,
	resetSeedEnsured,
	skillsAvailable,
} from "./service";
import { isParsedSkill, parseSkill } from "./parse";

beforeAll(async () => {
	await ready;
}, 30000);

const INLINE_SEEDS = ["csv-shaping", "report-writing", "json-shaping"];
const DIRECTORY_SKILLS = [
	"business-writing",
	"charts",
	"data-analysis",
	"excel",
	"pdf",
	"pdf-tools",
	"powerpoint",
	"themes",
	"weather",
	"word",
];

/** The current definition of one built-in, by name. */
function definition(name: string) {
	const builtin = listBuiltinSkills().find((skill) => skill.name === name);
	if (!builtin) throw new Error(`no built-in named ${name}`);
	return builtin;
}

/** A deployment row as it would exist in the field, with overrides. */
function row(overrides: Partial<Skill> & Pick<Skill, "name" | "description" | "content">): Skill {
	return {
		_id: new ObjectId(),
		userId: new ObjectId(),
		scope: "deployment",
		enabled: true,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as Skill;
}

beforeEach(async () => {
	// This file owns the deployment rows wholesale: every case starts from a
	// clean store and re-seeds what it needs. Sibling spec files run
	// serially (no-file-parallelism) and create their own rows per test.
	await collections.skills.deleteMany({ scope: "deployment" });
	resetSeedEnsured();
	resetAdminSkillCache();
	resetBuiltinSkillCache();
}, 20000);

afterEach(async () => {
	const previous = process.env.CHAT_SKILLS_DISABLED;
	if (previous === undefined) delete process.env.CHAT_SKILLS_DISABLED;
	else process.env.CHAT_SKILLS_DISABLED = previous;
	resetAdminSkillCache();
	resetBuiltinSkillCache();
	resetSeedEnsured();
});

describe("the built-in definitions", () => {
	it("are the three inline seeds plus the nine directories, all valid", () => {
		const builtins = listBuiltinSkills();
		expect(builtins.map((skill) => skill.name).sort()).toEqual(
			[...INLINE_SEEDS, ...DIRECTORY_SKILLS].sort()
		);
		for (const builtin of builtins) {
			expect(isParsedSkill(parseSkill(builtin.content)), builtin.name).toBe(true);
		}
	});

	it("carry bundled files on the directory skills", () => {
		expect(definition("pdf-tools").files.map((file) => file.path)).toContain(
			"scripts/pdf_tools.py"
		);
		expect(definition("powerpoint").files.map((file) => file.path)).toEqual(
			expect.arrayContaining(["scripts/generate.py", "scripts/edit.py", "scripts/validate.py"])
		);
		// generate.py must stay under the load_skill_file truncation cap —
		// a file past it arrives elided to the model.
		const generateScript = definition("powerpoint").files.find(
			(file) => file.path === "scripts/generate.py"
		);
		expect(generateScript?.content.length ?? 0).toBeLessThan(20_000);
		// The office editing helpers ship as small cooperating files (each one under
		// the same cap) so the model can load every one of them whole.
		for (const [skill, paths] of [
			["word", ["scripts/docx_edit.py", "scripts/docx_tables.py", "scripts/docx_verify.py"]],
			["powerpoint", ["scripts/pptx_edit.py", "scripts/pptx_slides.py", "scripts/pptx_verify.py"]],
			["excel", ["scripts/xlsx_patch.py"]],
		] as const) {
			for (const bundled of paths) {
				const file = definition(skill).files.find((candidate) => candidate.path === bundled);
				expect(file, `${skill}/${bundled}`).toBeDefined();
				expect(file?.content.length ?? 0, `${skill}/${bundled}`).toBeLessThan(20_000);
			}
		}
		for (const builtin of listBuiltinSkills()) {
			expect(
				builtin.files.filter((file) => file.path.includes("__pycache__")),
				builtin.name
			).toEqual([]);
		}
		expect(definition("themes").files.map((file) => file.path)).toContain(
			"references/themes/modern-minimalist.md"
		);
	});

	it("hash is stable across calls and file order, and moves with any change", () => {
		const content = "---\nname: hash-probe\ndescription: Hash stability.\n---\n\nBody.";
		const first = { path: "scripts/a.py", content: "one" };
		const second = { path: "scripts/b.py", content: "two" };
		const files = [first, second];
		expect(builtinSkillHash(content, files)).toBe(builtinSkillHash(content, [...files].reverse()));
		expect(builtinSkillHash(content, files)).not.toBe(builtinSkillHash(`${content}!`, files));
		expect(builtinSkillHash(content, files)).not.toBe(
			builtinSkillHash(content, [first, { path: "scripts/b.py", content: "two!" }])
		);
	});
});

describe("seed bootstrap", () => {
	it("seeds every built-in with its hash; directory skills keep their files", async () => {
		await ensureDeploymentSeeds();
		const rows = await listDeploymentSkills();
		expect(rows.map((row) => row.name).sort()).toEqual(
			[...INLINE_SEEDS, ...DIRECTORY_SKILLS].sort()
		);
		for (const seeded of rows) {
			const builtin = definition(seeded.name);
			expect(seeded.seedHash).toBe(builtin.hash);
			expect((seeded.files ?? []).map((file) => file.path).sort()).toEqual(
				builtin.files.map((file) => file.path).sort()
			);
		}
		expect(
			listAdminSkills()
				.map((skill) => skill.name)
				.sort()
		).toEqual([...INLINE_SEEDS, ...DIRECTORY_SKILLS].sort());
	});

	it("is idempotent: a second pass inserts nothing", async () => {
		await ensureDeploymentSeeds();
		await ensureDeploymentSeeds();
		expect(await collections.skills.countDocuments({ scope: "deployment" })).toBe(
			INLINE_SEEDS.length + DIRECTORY_SKILLS.length
		);
	});
});

describe("the seedHash upgrade rule", () => {
	it("replaces an unedited row with the newer definition, keeping enabled", async () => {
		const builtin = definition("pdf");
		const older = `${builtin.content}\n\n<!-- an older shipped revision -->`;
		await collections.skills.insertOne(
			row({
				name: "pdf",
				description: "older description",
				content: older,
				enabled: false,
				seedHash: builtinSkillHash(older, []),
			})
		);
		await resetSeedEnsured();
		await ensureDeploymentSeeds();
		const upgraded = await collections.skills.findOne({ scope: "deployment", name: "pdf" });
		expect(upgraded?.content).toBe(builtin.content);
		expect(upgraded?.description).toBe(builtin.description);
		expect(upgraded?.seedHash).toBe(builtin.hash);
		expect(upgraded?.files ?? []).toEqual([]);
		expect(upgraded?.enabled).toBe(false);
	});

	it("never touches a row an administrator has edited", async () => {
		const builtin = definition("pdf");
		await collections.skills.insertOne(
			row({
				name: "pdf",
				description: "The admin's own wording.",
				content: "---\nname: pdf\ndescription: Edited by an admin.\n---\n\nCustom body.",
				seedHash: builtin.hash,
			})
		);
		await resetSeedEnsured();
		await ensureDeploymentSeeds();
		const kept = await collections.skills.findOne({ scope: "deployment", name: "pdf" });
		expect(kept?.description).toBe("The admin's own wording.");
		expect(kept?.content).toContain("Custom body.");
		expect(kept?.seedHash).toBe(builtin.hash);
	});

	it("leaves a row whose files diverge from its recorded hash", async () => {
		// The equality filter compares files too: a row whose files differ
		// from what its seedHash describes is an edit, and must survive.
		const builtin = definition("excel");
		const older = `${builtin.content}\n\n<!-- older -->`;
		const handAdded = {
			path: "references/examples/openpyxl/hand-added.py",
			content: "# an admin's addition",
		};
		await collections.skills.insertOne(
			row({
				name: "excel",
				description: builtin.description,
				content: older,
				seedHash: builtinSkillHash(older, []),
				files: [handAdded],
			})
		);
		await resetSeedEnsured();
		await ensureDeploymentSeeds();
		const kept = await collections.skills.findOne({ scope: "deployment", name: "excel" });
		expect(kept?.content).toBe(older);
		expect(kept?.files?.map((file) => file.path)).toEqual([handAdded.path]);
	});

	it("stamps a legacy row that still matches the current definition", async () => {
		const builtin = definition("csv-shaping");
		await collections.skills.insertOne(
			row({
				name: "csv-shaping",
				description: builtin.description,
				content: builtin.content,
			})
		);
		await resetSeedEnsured();
		await ensureDeploymentSeeds();
		const stamped = await collections.skills.findOne({ scope: "deployment", name: "csv-shaping" });
		expect(stamped?.content).toBe(builtin.content);
		expect(stamped?.seedHash).toBe(builtin.hash);
	});

	it("leaves a legacy row whose content has diverged", async () => {
		await collections.skills.insertOne(
			row({
				name: "csv-shaping",
				description: "Reshaped by hand.",
				content: "---\nname: csv-shaping\ndescription: Hand-kept.\n---\n\nLocal rules.",
			})
		);
		await resetSeedEnsured();
		await ensureDeploymentSeeds();
		const kept = await collections.skills.findOne({ scope: "deployment", name: "csv-shaping" });
		expect(kept?.description).toBe("Reshaped by hand.");
		expect(kept?.seedHash).toBeUndefined();
	});
});

describe("turn-time resolution of built-ins", () => {
	it("serves a bundled file from a seeded row through findSkillFile", async () => {
		await ensureDeploymentSeeds();
		const file = await findSkillFile(undefined, "pdf-tools", "scripts/pdf_tools.py");
		expect(file?.content).toContain("def merge_pdfs");
		expect(await findSkillFile(undefined, "pdf-tools", "scripts/nope.py")).toBeUndefined();
		expect(await findSkillFile(undefined, "no-such-skill", "scripts/pdf_tools.py")).toBeUndefined();
	});

	it("resolves a directory built-in's body through the code fallback", async () => {
		// No rows at all: the in-memory definition stands in for the store.
		const resolved = await findSkillBody(undefined, "powerpoint");
		expect(resolved?.owner).toBe("admin");
		expect(resolved?.body).toContain("PowerPoint from layouts");
	});

	it("the kill switch filters built-ins by name", async () => {
		process.env.CHAT_SKILLS_DISABLED = "powerpoint,pdf-tools";
		resetAdminSkillCache();
		expect(await findSkillBody(undefined, "powerpoint")).toBeUndefined();
		expect(await findSkillFile(undefined, "pdf-tools", "scripts/pdf_tools.py")).toBeUndefined();
		expect((await listDeploymentSkills()).some((row) => row.name === "powerpoint")).toBe(false);
		expect(await skillsAvailable(undefined)).toBe(true);
	});
});
