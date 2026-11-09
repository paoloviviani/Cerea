import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/knowledge/readers", () => ({
	readerModelsFor: async () => [
		{ id: "markitdown", local: true },
		{ id: "mistral-ocr", local: false },
	],
}));
vi.mock("$lib/server/files/extractDocument", () => ({
	resolveExtractorModel: async () => "markitdown",
}));

import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { userDocumentReader } from "$lib/server/files/userReader";
import { GET, PUT } from "./+server";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
	await collections.settings.deleteMany({});
});

const put = (locals: App.Locals, body: unknown) =>
	testRequest(PUT, {
		path: "/api/v2/user/document-reader",
		method: "PUT",
		locals,
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
	});

describe("/api/v2/user/document-reader", () => {
	it("starts as the deployment's default, listing the readers the user may use", async () => {
		const user = await createTestUser();
		const locals = { ...user.locals, token: "tok" };
		const res = await testRequest(GET, { path: "/api/v2/user/document-reader", locals });
		expect(await res.json()).toEqual({
			reader_model: null,
			reader_models: ["markitdown", "mistral-ocr"],
			reader_default: "markitdown",
		});
		expect(await userDocumentReader(locals)).toBeUndefined();
	});

	it("saves a reader the user may use, and chat uploads resolve it", async () => {
		const user = await createTestUser();
		const locals = { ...user.locals, token: "tok" };
		expect((await put(locals, { reader_model: "mistral-ocr" })).status).toBe(200);
		expect(await userDocumentReader(locals)).toEqual({ model: "mistral-ocr", local: false });
		const res = await testRequest(GET, { path: "/api/v2/user/document-reader", locals });
		expect(((await res.json()) as { reader_model: string }).reader_model).toBe("mistral-ocr");
	});

	it("refuses a model the user may not use with a 400, and keeps what was saved", async () => {
		const user = await createTestUser();
		const locals = { ...user.locals, token: "tok" };
		await put(locals, { reader_model: "markitdown" });
		const res = await put(locals, { reader_model: "someone-elses-ocr" });
		expect(res.status).toBe(400);
		expect(await userDocumentReader(locals)).toEqual({ model: "markitdown", local: true });
	});

	it("null goes back to the deployment's default", async () => {
		const user = await createTestUser();
		const locals = { ...user.locals, token: "tok" };
		await put(locals, { reader_model: "markitdown" });
		expect((await put(locals, { reader_model: null })).status).toBe(200);
		expect(await userDocumentReader(locals)).toBeUndefined();
	});

	it("a body that is not an object, or a non-string reader, is a 400, not a 500", async () => {
		const user = await createTestUser();
		const locals = { ...user.locals, token: "tok" };
		for (const body of [null, "docling", 7, [], { reader_model: 5 }, { reader_model: ["x"] }, {}]) {
			expect((await put(locals, body)).status).toBe(400);
		}
	});
});
