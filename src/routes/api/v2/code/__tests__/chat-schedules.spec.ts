/**
 * Scheduled chats through the real `handle` hook, as a person the /code panel is not on for:
 * the API is theirs all the same. The gateway's key endpoints and the conversation turn are
 * scripted; what is under test is what the routes ask of them, who may see what, and that the
 * key never leaves the server.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import superjson from "superjson";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";

const flags = vi.hoisted(() => ({
	enabled: true,
	mint: vi.fn(),
	revoke: vi.fn(),
	cap: 20,
}));
vi.mock("$lib/server/identity/gatewayLogin", async (original) => ({
	...(await original<typeof import("$lib/server/identity/gatewayLogin")>()),
	isGatewayPreset: () => true,
}));
vi.mock("$lib/server/schedules/gatewayKeys", () => ({
	mintKey: (...args: unknown[]) => flags.mint(...args),
	revokeKey: (...args: unknown[]) => flags.revoke(...args),
}));
vi.mock("$lib/server/schedules/limits", async (original) => ({
	...(await original<typeof import("$lib/server/schedules/limits")>()),
	schedulesEnabled: () => flags.enabled,
	maxSchedulesPerUser: () => flags.cap,
}));
vi.mock("$lib/server/models", () => ({
	models: [{ id: "test-model" }],
	validateModel: () => null,
}));
vi.mock("../../../../conversation/[id]/+server", () => ({
	POST: async () => {
		const body = new ReadableStream<string>({
			start(controller) {
				controller.enqueue(JSON.stringify({ type: "status", status: "finished" }) + "\n");
				controller.close();
			},
		});
		return new Response(body);
	},
}));

import "$lib/server/schedules/chatScheduleExecutor";
import { GET as listGET, POST as listPOST } from "../schedules/+server";
import { DELETE as oneDELETE, GET as oneGET, PATCH as onePATCH } from "../schedules/[id]/+server";
import { POST as runPOST } from "../schedules/[id]/run/+server";
import { GET as runsGET } from "../schedules/[id]/runs/+server";
import { GET as conversationsGET } from "../../conversations/+server";
import { GET as conversationGET } from "../../conversations/[id]/+server";

await ready;

type Person = Awaited<ReturnType<typeof createTestUser>>;
let person: Person;
let conversationId: ObjectId;

async function call(
	handler: Parameters<typeof testRequest>[0],
	path: string,
	options: { as?: Person; method?: string; json?: unknown; params?: Record<string, string> } = {}
) {
	const who = options.as ?? person;
	const res = await testRequest(handler, {
		method: options.method ?? "GET",
		path,
		headers: { "content-type": "application/json", cookie: who.cookie },
		...(options.json !== undefined ? { body: JSON.stringify(options.json) } : {}),
		...(options.params ? { params: options.params } : {}),
		locals: { token: "session-token" },
	});
	const text = await res.text();
	let data: Record<string, unknown> = {};
	try {
		data = superjson.parse(text) as Record<string, unknown>;
	} catch {
		data = { raw: text };
	}
	return { status: res.status, data, text };
}

const body = (over: Record<string, unknown> = {}) => ({
	name: "Weekly news",
	kind: "chat",
	prompt: "summarise the news on X",
	recurrence: { type: "weekly", day: 1, at: "08:00" },
	timezone: "Europe/Rome",
	target: { mode: "continue", conversationId: conversationId.toString() },
	...over,
});

async function create(over: Record<string, unknown> = {}, as?: Person) {
	const res = await call(listPOST, "/api/v2/code/schedules", {
		method: "POST",
		json: body(over),
		as,
	});
	expect(res.status).toBe(201);
	return (res.data.schedule as { id: string }).id;
}

/** A person whose sign-in is fresh: everything under /api/v2/code needs one within 7 days. */
async function signedIn() {
	const p = await createTestUser();
	await collections.sessions.updateOne(
		{ sessionId: p.session.sessionId },
		{ $set: { authTime: new Date() } }
	);
	return p;
}

async function seedChat(owner: Person, title = "Planning") {
	const _id = new ObjectId();
	await collections.conversations.insertOne({
		_id,
		userId: owner.user._id,
		title,
		model: "test-model",
		rootMessageId: "r",
		messages: [{ id: "r", from: "system", content: "", ancestors: [], children: [] }],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return _id;
}

beforeEach(async () => {
	await cleanupTestData();
	await collections.schedules.deleteMany({});
	await collections.scheduleRuns.deleteMany({});
	vi.clearAllMocks();
	flags.enabled = true;
	flags.cap = 20;
	flags.mint.mockResolvedValue({ id: "key-1", secret: "sk-secret" });
	flags.revoke.mockResolvedValue(true);
	person = await signedIn();
	conversationId = await seedChat(person);
});

describe("making a chat schedule", () => {
	it("works for a person without the /code panel, mints their key with their session, and never shows it", async () => {
		const res = await call(listPOST, "/api/v2/code/schedules", { method: "POST", json: body() });

		expect(res.status).toBe(201);
		expect(res.data.schedule).toMatchObject({
			kind: "chat",
			name: "Weekly news",
			targetLabel: "Chat › Planning",
			enabled: true,
		});
		expect(flags.mint).toHaveBeenCalledWith({
			token: "session-token",
			name: "Cerea schedule: Weekly news",
		});
		expect(res.text).not.toContain("sk-secret");
		expect(res.text).not.toContain("credential");
		expect(res.text).not.toContain("sealed");
	});

	it("is refused, readably, when the gateway will not make the key", async () => {
		const { CredentialError } = await import("$lib/server/schedules/executors");
		flags.mint.mockRejectedValue(new CredentialError(403, "This account may not use API keys."));
		const res = await call(listPOST, "/api/v2/code/schedules", { method: "POST", json: body() });

		expect(res.status).toBe(403);
		expect(res.text).toContain("may not use API keys");
		expect(await collections.schedules.countDocuments({})).toBe(0);
	});

	it("takes a chat that is not theirs for one that does not exist", async () => {
		const other = await signedIn();
		const theirs = await seedChat(other, "Secret");
		const res = await call(listPOST, "/api/v2/code/schedules", {
			method: "POST",
			json: body({ target: { mode: "continue", conversationId: theirs.toString() } }),
		});
		expect(res.status).toBe(400);
		expect(res.text).toContain("not one of yours");
		expect(res.text).not.toContain("Secret");
	});

	it("counts toward the limit every kind of schedule shares", async () => {
		flags.cap = 1;
		await create();
		const res = await call(listPOST, "/api/v2/code/schedules", {
			method: "POST",
			json: body({ name: "Second" }),
		});
		expect(res.status).toBe(409);
		// The key made for the refused one is not left behind.
		expect(flags.mint).toHaveBeenCalledTimes(1);
	});

	it("does not touch the gateway for one made switched off", async () => {
		await create({ enabled: false });
		expect(flags.mint).not.toHaveBeenCalled();
	});
});

describe("managing one", () => {
	it("lists only the caller's own, and answers another person's id with 404", async () => {
		const id = await create();
		const other = await signedIn();
		const theirsConv = await seedChat(other);
		await create(
			{ name: "Theirs", target: { mode: "continue", conversationId: theirsConv.toString() } },
			other
		);

		const mine = await call(listGET, "/api/v2/code/schedules");
		expect((mine.data.schedules as { name: string }[]).map((x) => x.name)).toEqual(["Weekly news"]);
		const stolen = await call(oneGET, `/api/v2/code/schedules/${id}`, {
			as: other,
			params: { id },
		});
		expect(stolen.status).toBe(404);
		const deleted = await call(oneDELETE, `/api/v2/code/schedules/${id}`, {
			as: other,
			method: "DELETE",
			params: { id },
		});
		expect(deleted.status).toBe(404);
		expect(flags.revoke).not.toHaveBeenCalled();
	});

	it("keeps the key while it is off, and revokes it, as them, when it is deleted", async () => {
		const id = await create();
		const off = await call(onePATCH, `/api/v2/code/schedules/${id}`, {
			method: "PATCH",
			params: { id },
			json: { enabled: false },
		});
		expect(off.status).toBe(200);
		expect(flags.revoke).not.toHaveBeenCalled();

		const gone = await call(oneDELETE, `/api/v2/code/schedules/${id}`, {
			method: "DELETE",
			params: { id },
		});
		expect(gone.status).toBe(200);
		expect(flags.revoke).toHaveBeenCalledWith({ token: "session-token", keyId: "key-1" });
		expect(await collections.schedules.countDocuments({})).toBe(0);
	});

	it("runs now: the answer lands in the chat, the history links to it, and the chat reads unread", async () => {
		const id = await create();
		const run = await call(runPOST, `/api/v2/code/schedules/${id}/run`, {
			method: "POST",
			params: { id },
			json: {},
		});
		expect(run.status).toBe(200);
		expect(run.data.run).toMatchObject({
			status: "sent",
			trigger: "manual",
			result: { type: "chat", ids: { conversationId: conversationId.toString() } },
		});

		const runs = await call(runsGET, `/api/v2/code/schedules/${id}/runs`, { params: { id } });
		expect((runs.data.runs as unknown[]).length).toBe(1);

		const list = await call(conversationsGET, "/api/v2/conversations");
		const row = (list.data.conversations as { id: unknown; unread?: boolean }[]).find(
			(c) => String(c.id) === conversationId.toString()
		);
		expect(row?.unread).toBe(true);
	});

	it("reads the chat when its owner opens it", async () => {
		await collections.conversations.updateOne(
			{ _id: conversationId },
			{ $set: { scheduledUnread: true } }
		);
		const opened = await call(conversationGET, `/api/v2/conversations/${conversationId}`, {
			params: { id: conversationId.toString() },
		});
		expect(opened.status).toBe(200);
		expect(
			(await collections.conversations.findOne({ _id: conversationId }))?.scheduledUnread
		).toBeUndefined();
	});
});

describe("the deployment switch", () => {
	it("answers 404 for everything when scheduled actions are switched off", async () => {
		const id = await create();
		flags.enabled = false;
		expect((await call(listGET, "/api/v2/code/schedules")).status).toBe(404);
		expect((await call(oneGET, `/api/v2/code/schedules/${id}`, { params: { id } })).status).toBe(
			404
		);
	});
});
