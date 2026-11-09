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

const { skillLoadBuiltin } = await import("./service");
const { assembleSkillsContext } = await import("./prompt");
const { documentSpecSection, withDocumentSpec } = await import("./documentSpec");

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
		// before the in-sandbox fallback, which the spec is not part of
		const fallback = text.indexOf("## Fallback");
		if (fallback >= 0) expect(text.indexOf("spec for " + format)).toBeLessThan(fallback);
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

describe("documentSpecSection and withDocumentSpec", () => {
	it("is empty for a user's own skill of the same name", async () => {
		expect(await documentSpecSection("word", "user")).toBe("");
		expect(await documentSpecSection("word", "admin")).not.toBe("");
	});

	it("appends when the body has no fallback section, and is a no-op without a spec", () => {
		expect(withDocumentSpec("body", "\n\n## S\nspec")).toBe("body\n\n## S\nspec");
		expect(withDocumentSpec("body", "")).toBe("body");
	});
});
