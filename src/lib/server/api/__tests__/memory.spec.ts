/**
 * User memory over its own routes: listed, added, rewritten and deleted by
 * the owner only; refused without login; and withdrawn deployment-wide by
 * `CHAT_MEMORY_ENABLED=false` — except deleting, which must stay possible
 * so switching the feature off never strands what people already stored.
 *
 * Driven through `testRequest`, so the handle hook's auth runs as it does in
 * production: `locals` set what the handler sees, and the 401 below proves
 * the route (not the test harness) demands a user.
 */

import { describe, expect, it, afterEach, beforeAll, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { createTestLocals, createTestUser, type TestUser } from "./testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { GET, POST } from "../../../../routes/api/v2/memory/+server";
import { DELETE, PATCH } from "../../../../routes/api/v2/memory/[id]/+server";
import type { MemoryView } from "$lib/types/Memory";

// The deployment flag is read through the config proxy; mocked the way
// misc.spec.ts mocks CHAT_KNOWLEDGE_ENABLED, so it is controllable per test
// while everything else resolves through the real config.
const configState = vi.hoisted(() => ({ memoryEnabled: undefined as boolean | undefined }));

vi.mock("$lib/server/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/config")>();
	return {
		...actual,
		get config() {
			return new Proxy(actual.config, {
				get(target, prop, receiver) {
					if (prop === "CHAT_MEMORY_ENABLED" && configState.memoryEnabled !== undefined) {
						return configState.memoryEnabled ? "true" : "false";
					}
					return Reflect.get(target, prop, receiver);
				},
			});
		},
	};
});

beforeAll(async () => {
	await ready;
}, 30000);

/** Users this file created, so the cleanup can name their rows. */
const users: TestUser[] = [];

async function user() {
	const created = await createTestUser();
	users.push(created);
	return created;
}

afterEach(async () => {
	vi.unstubAllGlobals();
	configState.memoryEnabled = undefined;
	if (users.length) {
		await collections.memories.deleteMany({
			userId: { $in: users.map((entry) => entry.user._id) },
		});
		users.length = 0;
	}
});

function jsonBody(method: string, body: unknown) {
	return {
		method,
		body: JSON.stringify(body),
		headers: { "Content-Type": "application/json" },
	} as const;
}

async function postMemory(locals: App.Locals, text: string) {
	return testRequest(POST, {
		path: "/api/v2/memory",
		locals,
		...jsonBody("POST", { text }),
	});
}

async function readBody(res: Response) {
	return (await res.json()) as {
		data: { memories: MemoryView[] } & MemoryView & { enabled: boolean };
	};
}

describe("GET /api/v2/memory", () => {
	it("lists nothing for a fresh user, with the opt-in reported off", async () => {
		const { locals } = await user();
		const res = await testRequest(GET, { path: "/api/v2/memory", locals });
		expect(res.status).toBe(200);
		const body = await readBody(res);
		expect(body.data.memories).toEqual([]);
		expect(body.data.enabled).toBe(false);
	});

	it("401s without a signed-in user", async () => {
		const res = await testRequest(GET, {
			path: "/api/v2/memory",
			locals: createTestLocals(),
		});
		expect(res.status).toBe(401);
	});

	it("404s when the deployment flag is off", async () => {
		configState.memoryEnabled = false;
		const { locals } = await user();
		const res = await testRequest(GET, { path: "/api/v2/memory", locals });
		expect(res.status).toBe(404);
	});
});

describe("POST /api/v2/memory", () => {
	it("stores a fact as the caller's own and lists it back", async () => {
		const { locals } = await user();
		const created = await postMemory(locals, "Prefers concise answers.");
		expect(created.status).toBe(201);
		const createdBody = (await created.json()) as { data: MemoryView };
		expect(createdBody.data.text).toBe("Prefers concise answers.");
		expect(createdBody.data.source).toBe("user");
		expect(createdBody.data.id).toMatch(/^[0-9a-f]{24}$/);

		const listed = await testRequest(GET, { path: "/api/v2/memory", locals });
		const listedBody = await readBody(listed);
		expect(listedBody.data.memories.map((row) => row.text)).toEqual(["Prefers concise answers."]);
	});

	it("400s on an empty fact and stores nothing", async () => {
		const { user: owner, locals } = await user();
		const res = await postMemory(locals, "   ");
		expect(res.status).toBe(400);
		expect(await collections.memories.countDocuments({ userId: owner._id })).toBe(0);
	});

	it("never shows one person's facts to another", async () => {
		const first = await user();
		const second = await user();
		await postMemory(first.locals, "Private fact.");
		const listed = await testRequest(GET, { path: "/api/v2/memory", locals: second.locals });
		expect((await readBody(listed)).data.memories).toEqual([]);
	});

	it("404s when the deployment flag is off and stores nothing", async () => {
		configState.memoryEnabled = false;
		const { user: owner, locals } = await user();
		const res = await postMemory(locals, "Prefers concise answers.");
		expect(res.status).toBe(404);
		expect(await collections.memories.countDocuments({ userId: owner._id })).toBe(0);
	});
});

describe("PATCH /api/v2/memory/[id]", () => {
	it("rewrites an owned fact", async () => {
		const { locals } = await user();
		const created = (await (await postMemory(locals, "Speaks Italian.")).json()) as {
			data: MemoryView;
		};
		const res = await testRequest(PATCH, {
			path: `/api/v2/memory/${created.data.id}`,
			params: { id: created.data.id },
			locals,
			...jsonBody("PATCH", { text: "Speaks French." }),
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { data: MemoryView }).data.text).toBe("Speaks French.");
	});

	it("404s a stranger's id, a missing row and a malformed one alike", async () => {
		const first = await user();
		const second = await user();
		const created = (await (await postMemory(first.locals, "Private fact.")).json()) as {
			data: MemoryView;
		};
		for (const id of [created.data.id, new ObjectId().toString(), "not-an-id"]) {
			const res = await testRequest(PATCH, {
				path: `/api/v2/memory/${id}`,
				params: { id },
				locals: second.locals,
				...jsonBody("PATCH", { text: "Rewritten." }),
			});
			expect(res.status).toBe(404);
		}
		// The row survives all three attempts.
		const listed = await testRequest(GET, { path: "/api/v2/memory", locals: first.locals });
		expect((await readBody(listed)).data.memories.map((row) => row.text)).toEqual([
			"Private fact.",
		]);
	});

	it("404s when the deployment flag is off and leaves the row alone", async () => {
		const { locals } = await user();
		const created = (await (await postMemory(locals, "Private fact.")).json()) as {
			data: MemoryView;
		};
		configState.memoryEnabled = false;
		const res = await testRequest(PATCH, {
			path: `/api/v2/memory/${created.data.id}`,
			params: { id: created.data.id },
			locals,
			...jsonBody("PATCH", { text: "Rewritten." }),
		});
		expect(res.status).toBe(404);
		configState.memoryEnabled = true;
		const listed = await testRequest(GET, { path: "/api/v2/memory", locals });
		expect((await readBody(listed)).data.memories.map((row) => row.text)).toEqual([
			"Private fact.",
		]);
	});
});

describe("DELETE /api/v2/memory/[id]", () => {
	it("deletes an owned fact and then reports it gone", async () => {
		const { locals } = await user();
		const created = (await (await postMemory(locals, "Temporary fact.")).json()) as {
			data: MemoryView;
		};
		const deleted = await testRequest(DELETE, {
			path: `/api/v2/memory/${created.data.id}`,
			params: { id: created.data.id },
			locals,
			method: "DELETE",
		});
		expect(deleted.status).toBe(204);
		const again = await testRequest(DELETE, {
			path: `/api/v2/memory/${created.data.id}`,
			params: { id: created.data.id },
			locals,
			method: "DELETE",
		});
		expect(again.status).toBe(404);
	});

	it("404s a stranger's id, so one person cannot clear another's", async () => {
		const first = await user();
		const second = await user();
		const created = (await (await postMemory(first.locals, "Private fact.")).json()) as {
			data: MemoryView;
		};
		const res = await testRequest(DELETE, {
			path: `/api/v2/memory/${created.data.id}`,
			params: { id: created.data.id },
			locals: second.locals,
			method: "DELETE",
		});
		expect(res.status).toBe(404);
		expect(await collections.memories.countDocuments({ _id: new ObjectId(created.data.id) })).toBe(
			1
		);
	});

	it("still deletes when the deployment flag is off — off must not strand data", async () => {
		const { locals } = await user();
		const created = (await (await postMemory(locals, "Temporary fact.")).json()) as {
			data: MemoryView;
		};
		configState.memoryEnabled = false;
		const deleted = await testRequest(DELETE, {
			path: `/api/v2/memory/${created.data.id}`,
			params: { id: created.data.id },
			locals,
			method: "DELETE",
		});
		expect(deleted.status).toBe(204);
	});
});
