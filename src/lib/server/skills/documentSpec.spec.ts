/**
 * The creation spec of a document format arrives with that format's skill (not in the `doc_create` definition):
 * through `load_skill` and through an `@name` mention, generated from the document service's schemas, placed
 * before the skill's fallback section, and absent for any other skill, a user's own skill or a deployment
 * without the service.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import fixture from "$lib/server/documents/capabilities.fixture.json";

const caps = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("$lib/server/documents/client", async (importOriginal) => {
	const real = await importOriginal<typeof import("$lib/server/documents/client")>();
	return { ...real, getCapabilities: vi.fn(async () => caps.value ?? null) };
});

const { skillLoadBuiltin, createSkill } = await import("./service");
const { assembleSkillsContext } = await import("./prompt");
const { documentSpecSection, withDocumentSpec, documentSpecSkills } =
	await import("./documentSpec");
const { MAX_REPLAYED_TOOL_OUTPUT_CHARS } =
	await import("$lib/server/textGeneration/utils/prepareFiles");
const { createFormatSpec } = await import("$lib/server/textGeneration/builtinTools/documentTools");

beforeAll(async () => {
	await ready;
}, 30000);

const owner = new ObjectId();
const ctx = { uuid: "u", toolCallId: "t", userId: owner };

beforeEach(async () => {
	caps.value = fixture;
	await collections.skills.deleteMany({ userId: owner });
});

const load = async (name: string) => {
	const r = await skillLoadBuiltin.execute({ name }, ctx);
	if (!("resultText" in r)) throw new Error(JSON.stringify(r));
	return r.resultText;
};

describe("load_skill delivers the format's spec", () => {
	it.each([
		["word", "docx", "heading{level: integer"],
		["excel", "xlsx", "A sheet: {"],
		["powerpoint", "pptx", "A slide: {"],
		["pdf", "pdf", "heading{level: integer"],
	])("%s carries the %s spec", async (name, format, needle) => {
		const text = await load(name);
		expect(text).toContain(`## The \`doc_create\` spec for ${format}`);
		expect(text).toContain(needle);
		// first, right after the description and before the guidance
		expect(text.indexOf("## The `doc_create` spec for")).toBeLessThan(1_200);
	});

	it.each([
		["word", "docx"],
		["excel", "xlsx"],
		["powerpoint", "pptx"],
		["pdf", "pdf"],
	] as const)("%s: the whole spec survives the turn-2 replay cap", async (name, format) => {
		const text = await load(name);
		const replayed = text.slice(0, MAX_REPLAYED_TOOL_OUTPUT_CHARS);
		const spec = createFormatSpec(fixture as never, format);
		expect(replayed).toContain(spec);
	});

	it("adds nothing for a format the service does not list in create_formats", async () => {
		caps.value = { ...(fixture as object), create_formats: ["docx"] };
		expect(await load("word")).toContain("\n## The `doc_create` spec for docx");
		expect(await load("excel")).not.toContain("\n## The `doc_create` spec for xlsx");
	});

	it("gives each format only its own spec", async () => {
		const excel = await load("excel");
		expect(excel).not.toContain("A slide: {");
		expect(await load("powerpoint")).not.toContain("A sheet: {");
	});

	it("leaves other skills alone", async () => {
		expect(await load("themes")).not.toContain("\n## The `doc_create` spec for");
	});

	it("adds nothing without the service, or when it does not offer create", async () => {
		caps.value = null;
		expect(await load("word")).not.toContain("\n## The `doc_create` spec for");
		caps.value = { ...(fixture as object), create: false };
		expect(await load("word")).not.toContain("\n## The `doc_create` spec for");
	});
});

describe("an @mention delivers it too", () => {
	it("puts the spec in the loaded skill section of the preprompt", async () => {
		const { preprompt } = await assembleSkillsContext(owner, "make a sheet with @excel please");
		expect(preprompt).toContain("## Skill: excel");
		expect(preprompt).toContain("## The `doc_create` spec for xlsx");
	});
});

describe("documentSpecSkills", () => {
	it("lists the format skills that resolve to the deployment's own", async () => {
		expect([...(await documentSpecSkills(owner))].sort()).toEqual([
			"excel",
			"pdf",
			"powerpoint",
			"word",
		]);
	});

	it("leaves out one a person replaced with their own", async () => {
		await createSkill(owner, "---\nname: excel\ndescription: mine\n---\n\nmy way\n");
		expect([...(await documentSpecSkills(owner))]).not.toContain("excel");
		expect([...(await documentSpecSkills(owner))]).toContain("word");
	});
});

describe("documentSpecSection and withDocumentSpec", () => {
	it("is empty for a user's own skill of the same name", async () => {
		expect(await documentSpecSection("word", "user")).toBe("");
		expect(await documentSpecSection("word", "admin")).not.toBe("");
	});

	it("puts the spec first, and is a no-op without one", () => {
		expect(withDocumentSpec("body", "\n\n## S\nspec")).toBe("## S\nspec\n\nbody");
		expect(withDocumentSpec("body", "")).toBe("body");
	});
});
