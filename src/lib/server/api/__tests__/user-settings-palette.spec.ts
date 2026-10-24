import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import superjson from "superjson";
import { collections, ready } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { paletteAttributesFor } from "$lib/server/paletteSettings";
import { createTestUser, cleanupTestData } from "./testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { GET, POST } from "../../../../routes/api/v2/user/settings/+server";
import { POST as legacyPOST } from "../../../../routes/settings/(nav)/+server";

/**
 * The accent and tone ride on the settings both endpoints save: validated
 * against the fixed lists, unknown values ignored (not a 400, not a wipe), and
 * an older client that omits them must leave a saved choice alone.
 */
beforeAll(async () => {
	await ready;
});

const post = (locals: App.Locals, body: unknown) =>
	testRequest(POST, {
		path: "/api/v2/user/settings",
		locals,
		method: "POST",
		body: JSON.stringify(body),
		headers: { "Content-Type": "application/json" },
	});

const legacyPost = (locals: App.Locals, body: unknown) =>
	testRequest(legacyPOST, {
		path: "/settings",
		locals,
		method: "POST",
		body: JSON.stringify(body),
		headers: { "Content-Type": "application/json" },
	});

const stored = (locals: App.Locals) => collections.settings.findOne(authCondition(locals));

describe.each([
	["POST /api/v2/user/settings", post],
	["POST /settings (the path the client store saves through)", legacyPost],
])("palette on %s", (_name, save) => {
	beforeEach(async () => {
		await cleanupTestData();
		await collections.settings.deleteMany({});
	}, 20000);

	it("persists a valid accent and neutral", async () => {
		const { locals } = await createTestUser();
		expect((await save(locals, { accent: "teal", neutral: "warm" })).status).toBe(200);
		const s = await stored(locals);
		expect([s?.accent, s?.neutral]).toEqual(["teal", "warm"]);
	});

	it("saves an old tone id as the tone that replaced it", async () => {
		const { locals } = await createTestUser();
		for (const [old, now] of [
			["gray", "neutral"],
			["slate", "cool"],
			["stone", "warm"],
		]) {
			expect((await save(locals, { neutral: old })).status).toBe(200);
			expect((await stored(locals))?.neutral).toBe(now);
		}
	});

	it("persists the defaults explicitly, so going back to blue sticks", async () => {
		const { locals } = await createTestUser();
		await save(locals, { accent: "teal", neutral: "warm" });
		await save(locals, { accent: "blue", neutral: "neutral" });
		const s = await stored(locals);
		expect([s?.accent, s?.neutral]).toEqual(["blue", "neutral"]);
	});

	it("ignores an unknown value instead of failing the save or wiping the choice", async () => {
		const { locals } = await createTestUser();
		await save(locals, { accent: "teal", neutral: "warm" });
		const res = await save(locals, {
			accent: "chartreuse",
			neutral: 7,
			directPaste: true,
		});
		expect(res.status).toBe(200);
		const s = await stored(locals);
		expect([s?.accent, s?.neutral]).toEqual(["teal", "warm"]);
		// The rest of the save still went through.
		expect(s?.directPaste).toBe(true);
	});

	it("stores nothing for a first save that names no palette", async () => {
		const { locals } = await createTestUser();
		await save(locals, { directPaste: true });
		const s = await stored(locals);
		expect(s).not.toBeNull();
		expect(s && "accent" in s).toBe(false);
		expect(s && "neutral" in s).toBe(false);
	});

	it("leaves a saved choice alone when a client omits the fields", async () => {
		const { locals } = await createTestUser();
		await save(locals, { accent: "violet", neutral: "cool" });
		await save(locals, { directPaste: true });
		const s = await stored(locals);
		expect([s?.accent, s?.neutral]).toEqual(["violet", "cool"]);
	});
});

describe("GET /api/v2/user/settings palette", () => {
	beforeEach(async () => {
		await cleanupTestData();
		await collections.settings.deleteMany({});
	}, 20000);

	const read = async (locals: App.Locals) =>
		superjson.parse<{ accent: string; neutral: string }>(
			await (await testRequest(GET, { path: "/api/v2/user/settings", locals })).text()
		);

	it("reports the defaults for a person who never chose", async () => {
		const { locals } = await createTestUser();
		const s = await read(locals);
		expect([s.accent, s.neutral]).toEqual(["blue", "neutral"]);
	});

	it("reads a tone saved under its old name as its replacement", async () => {
		const { locals, user } = await createTestUser();
		await collections.settings.insertOne({
			userId: user._id,
			neutral: "slate",
			createdAt: new Date(),
			updatedAt: new Date(),
			activeModel: "m",
			streamingMode: "smooth",
			directPaste: false,
			hapticsEnabled: true,
		} as never);
		expect((await read(locals)).neutral).toBe("cool");
		expect(await paletteAttributesFor(locals)).toBe('data-neutral="cool"');
	});

	it("reports what was chosen, and the default for a stored value it does not know", async () => {
		const { locals, user } = await createTestUser();
		await collections.settings.insertOne({
			userId: user._id,
			accent: "orange",
			neutral: "not-a-tone",
			createdAt: new Date(),
			updatedAt: new Date(),
			// Fields the type requires and this test does not care about.
			activeModel: "m",
			streamingMode: "smooth",
			directPaste: false,
			hapticsEnabled: true,
		} as never);
		const s = await read(locals);
		expect([s.accent, s.neutral]).toEqual(["orange", "neutral"]);
	});
});

describe("paletteAttributesFor (the server-rendered <html>)", () => {
	beforeEach(async () => {
		await cleanupTestData();
		await collections.settings.deleteMany({});
	}, 20000);

	it("is empty for the defaults and for a person with no settings", async () => {
		const { locals } = await createTestUser();
		expect(await paletteAttributesFor(locals)).toBe("");
		await post(locals, { accent: "blue", neutral: "neutral" });
		expect(await paletteAttributesFor(locals)).toBe("");
	});

	it("carries only what differs from the default", async () => {
		const { locals } = await createTestUser();
		await post(locals, { accent: "teal", neutral: "neutral" });
		expect(await paletteAttributesFor(locals)).toBe('data-accent="teal"');
		await post(locals, { accent: "teal", neutral: "warm" });
		expect(await paletteAttributesFor(locals)).toBe('data-accent="teal" data-neutral="warm"');
	});

	it("never throws: a request with no identity renders the default", async () => {
		expect(await paletteAttributesFor({} as App.Locals)).toBe("");
	});
});
