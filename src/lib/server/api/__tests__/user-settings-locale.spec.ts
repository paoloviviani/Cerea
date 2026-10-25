import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import superjson from "superjson";
import { collections, ready } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { localePatch, savedLocaleFor } from "$lib/server/localeSettings";
import { createTestUser, cleanupTestData } from "./testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { GET, POST } from "../../../../routes/api/v2/user/settings/+server";
import { POST as legacyPOST } from "../../../../routes/settings/(nav)/+server";

/**
 * The language rides on the settings both endpoints save, like the palette:
 * only a locale this deployment may serve is stored, anything else is ignored
 * (not a 400, not a wipe), a null is "unset", and an older client that omits
 * the field leaves a saved choice alone.
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
])("locale on %s", (_name, save) => {
	beforeEach(async () => {
		await cleanupTestData();
		await collections.settings.deleteMany({});
	}, 20000);

	it("persists a carried locale and reads it back", async () => {
		const { locals } = await createTestUser();
		expect((await save(locals, { locale: "en" })).status).toBe(200);
		expect((await stored(locals))?.locale).toBe("en");
		expect(await savedLocaleFor(locals)).toBe("en");
	});

	it("ignores a locale it does not carry, without failing the rest of the save", async () => {
		const { locals } = await createTestUser();
		await save(locals, { locale: "en" });
		const res = await save(locals, { locale: "klingon", accent: "teal" });
		expect(res.status).toBe(200);
		const s = await stored(locals);
		expect([s?.locale, s?.accent]).toEqual(["en", "teal"]);
	});

	it("leaves a saved choice alone when an older client omits the field or sends null", async () => {
		const { locals } = await createTestUser();
		await save(locals, { locale: "en" });
		await save(locals, { accent: "rose" });
		expect((await stored(locals))?.locale).toBe("en");
		await save(locals, { locale: null });
		expect((await stored(locals))?.locale).toBe("en");
	});

	it("takes the pseudo-locale in development, where the flag is on", async () => {
		const { locals } = await createTestUser();
		await save(locals, { locale: "en-XA" });
		expect((await stored(locals))?.locale).toBe("en-XA");
	});
});

describe("locale on GET /api/v2/user/settings", () => {
	beforeEach(async () => {
		await cleanupTestData();
		await collections.settings.deleteMany({});
	}, 20000);

	it("reports the saved locale, and nothing (null on the wire) when there is none", async () => {
		const { locals } = await createTestUser();
		const read = async () => {
			const res = await testRequest(GET, { path: "/api/v2/user/settings", locals });
			return superjson.parse<{ locale?: string }>(await res.text()).locale;
		};
		expect(await read()).toBeUndefined();
		await post(locals, { locale: "en" });
		expect(await read()).toBe("en");
	});

	it("accepts what it itself reports, nulls included, back on POST", async () => {
		const { locals } = await createTestUser();
		expect((await post(locals, { locale: null, accent: null })).status).toBe(200);
	});
});

describe("localePatch", () => {
	it("stores a locale only when this deployment may serve it", () => {
		expect(localePatch({ locale: "en" }, false)).toEqual({ locale: "en" });
		expect(localePatch({ locale: "en-XA" }, false)).toEqual({});
		expect(localePatch({ locale: "en-XA" }, true)).toEqual({ locale: "en-XA" });
		expect(localePatch({ locale: "klingon" }, true)).toEqual({});
		expect(localePatch({ locale: null }, true)).toEqual({});
		expect(localePatch({}, true)).toEqual({});
	});
});
