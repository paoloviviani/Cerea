/**
 * The "chat" executor: both modes, the still-running skip, how a turn's error becomes a
 * status (and a dead key a disabled schedule), and the unread mark. The conversation
 * route is replaced by a scripted turn: what is under test is what the executor asks of
 * it and what it makes of the answer. What the pipeline withholds from a scheduled run is
 * pinned where that lives (`builtinTools.spec.ts`, `toolInvocation`, `preprompt.spec.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { open } from "$lib/server/mcp/secretBox";

const flags = vi.hoisted(() => ({
	gateway: true,
	refresh: vi.fn(),
	revoke: vi.fn(),
	turn: vi.fn(),
	create: vi.fn(),
	notify: vi.fn(async () => ({})),
	groups: [] as string[],
}));
vi.mock("$lib/server/projects", async (original) => ({
	...(await original<typeof import("$lib/server/projects")>()),
	viewerPrincipals: async () => ({ groups: flags.groups }),
}));

vi.mock("$lib/server/identity/gatewayLogin", async (original) => ({
	...(await original<typeof import("$lib/server/identity/gatewayLogin")>()),
	isGatewayPreset: () => flags.gateway,
}));
vi.mock("$lib/server/auth", async (original) => ({
	...(await original<typeof import("$lib/server/auth")>()),
	refreshOAuthToken: (...args: unknown[]) => flags.refresh(...args),
	revokeOAuthToken: (...args: unknown[]) => flags.revoke(...args),
}));
vi.mock("$lib/server/models", () => ({
	models: [{ id: "test-model" }, { id: "other-model" }],
	validateModel: () => z.enum(["test-model", "other-model"]),
}));
vi.mock("$lib/server/push/notify", () => ({ notifyUser: flags.notify }));
vi.mock("../../../routes/conversation/[id]/+server", () => ({
	POST: (event: unknown) => flags.turn(event),
}));
vi.mock("../../../routes/conversation/+server", () => ({
	POST: (event: unknown) => flags.create(event),
}));
vi.mock("./limits", async (original) => ({
	...(await original<typeof import("./limits")>()),
	schedulesEnabled: () => true,
}));

import "./chatScheduleExecutor";
import { chatRunConfig, conversationBusy, parseChatTarget } from "./chatScheduleExecutor";
import {
	accessTokenFor,
	hasGrant,
	NEEDS_GRANT,
	saveGrant,
	scheduleGrantUsable,
	SIGN_IN_AGAIN,
	stopScheduleUse,
} from "./grants";
import { getExecutor } from "./executors";
import { runNow } from "./scheduler";
import { createSchedule, deleteSchedule, getSchedule, updateSchedule } from "./store";
import type { Schedule } from "$lib/types/Schedule";

await ready;

const executor = getExecutor("chat");
if (!executor) throw new Error("the chat executor did not register");

const ACCESS = "at-1";

/** Give the person a background grant, as the authorization callback would. */
async function giveGrant(
	user = person,
	tokens: { refresh?: string; access?: string; expiresInMs?: number } = {}
) {
	await saveGrant(user.user._id, {
		refresh_token: tokens.refresh ?? "rt-1",
		access_token: tokens.access ?? ACCESS,
		expires_at: Math.floor((Date.now() + (tokens.expiresInMs ?? 3600_000)) / 1000),
	} as never);
	// A short life is a token that has run out: the refresh leeway is a share of the lifetime now.
	if (tokens.expiresInMs !== undefined && tokens.expiresInMs < 60_000) {
		await collections.scheduleGrants.updateOne(
			{ userId: user.user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() - 1000) } }
		);
	}
}

/** A turn's wire answer: JSON lines, as the conversation route writes them. */
function turnResponse(events: object[], delayMs = 0): Response {
	// Strings, as the route enqueues them (`controller.enqueue(JSON.stringify(event) + "\n")`).
	const body = new ReadableStream<string>({
		async start(controller) {
			if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
			for (const event of events) {
				controller.enqueue(JSON.stringify(event) + "\n");
			}
			controller.close();
		},
	});
	return new Response(body);
}
const finished = { type: "status", status: "finished" };
const failedWith = (statusCode?: number, message = "boom") => ({
	type: "status",
	status: "error",
	message,
	...(statusCode ? { statusCode } : {}),
});

const createdWith: unknown[] = [];
let person: Awaited<ReturnType<typeof createTestUser>>;
let conversationId: ObjectId;

async function seedConversation(
	over: Record<string, unknown> = {},
	owner = person
): Promise<ObjectId> {
	const _id = new ObjectId();
	await collections.conversations.insertOne({
		_id,
		userId: owner.user._id,
		title: "Weekly notes",
		model: "test-model",
		rootMessageId: "root",
		messages: [
			{ id: "root", from: "system", content: "", ancestors: [], children: ["u1"] },
			{ id: "u1", from: "user", content: "hi", ancestors: ["root"], children: ["a1"] },
			{ id: "a1", from: "assistant", content: "hello", ancestors: ["root", "u1"], children: [] },
		],
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	} as never);
	return _id;
}

async function make(
	target: Record<string, unknown>,
	over: Record<string, unknown> = {}
): Promise<Schedule> {
	return createSchedule(
		person.user._id,
		{
			name: "Weekly news",
			kind: "chat",
			prompt: "summarise the news on X",
			recurrence: { type: "weekly", day: 1, at: "08:00" },
			timezone: "Europe/Rome",
			target,
			...over,
		},
		{ token: "session-token" }
	);
}

beforeEach(async () => {
	await cleanupTestData();
	await collections.schedules.deleteMany({});
	await collections.scheduleRuns.deleteMany({});
	await collections.turnStates.deleteMany({});
	await collections.scheduleGrants.deleteMany({});
	await collections.settings.deleteMany({});
	await collections.projects.deleteMany({});
	flags.groups = [];
	chatRunConfig.maxConcurrent = 4;
	vi.clearAllMocks();
	createdWith.length = 0;
	flags.gateway = true;
	chatRunConfig.earlyWindowMs = 5_000;
	flags.refresh.mockResolvedValue({
		access_token: "at-fresh",
		refresh_token: "rt-rotated",
		expires_at: Math.floor((Date.now() + 3600_000) / 1000),
	});
	flags.revoke.mockResolvedValue(true);
	flags.turn.mockImplementation(async () => turnResponse([finished]));
	person = await createTestUser();
	await giveGrant();
	conversationId = await seedConversation();
});

describe("the permission mode", () => {
	const caller = () => ({ userId: person.user._id });
	const asks = () => ({ mode: "continue", conversationId: conversationId.toString() });
	const setPolicy = (policy: "always-allow" | "manual") =>
		collections.settings.updateOne(
			{ userId: person.user._id },
			{ $set: { toolApprovalPolicy: policy, createdAt: new Date(), updatedAt: new Date() } },
			{ upsert: true }
		);

	it("defaults to the person's policy: Ask on manual, Allow on always-allow", async () => {
		const manual = await executor.validateTarget(asks(), caller());
		expect(manual).toMatchObject({ ok: true, target: { permissionMode: "ask" } });
		await setPolicy("always-allow");
		const open = await executor.validateTarget(asks(), caller());
		expect(open).toMatchObject({ ok: true, target: { permissionMode: "allow" } });
	});

	it("refuses Allow for a person on the manual policy, and accepts it on always-allow", async () => {
		const refused = await executor.validateTarget({ ...asks(), permissionMode: "allow" }, caller());
		expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("manual") });
		await setPolicy("always-allow");
		const granted = await executor.validateTarget({ ...asks(), permissionMode: "allow" }, caller());
		expect(granted).toMatchObject({ ok: true, target: { permissionMode: "allow" } });
		// Ask is always allowed.
		expect(
			await executor.validateTarget({ ...asks(), permissionMode: "ask" }, caller())
		).toMatchObject({ ok: true, target: { permissionMode: "ask" } });
	});

	it("is checked again on an edit: switching an Allow schedule's policy off makes it refuse", async () => {
		await setPolicy("always-allow");
		const schedule = await make({ ...asks(), permissionMode: "allow" });
		await setPolicy("manual");
		await expect(
			updateSchedule(person.user._id, schedule._id.toString(), {
				target: { ...asks(), permissionMode: "allow" },
			})
		).rejects.toMatchObject({ status: 400 });
	});

	it("runs in the stored mode, but never looser than the person's policy now", async () => {
		await setPolicy("always-allow");
		const schedule = await make({ ...asks(), permissionMode: "allow" });
		await runNow(person.user._id, schedule._id.toString());
		expect((flags.turn.mock.calls[0][0] as { locals: App.Locals }).locals.scheduledRun).toEqual({
			permissionMode: "allow",
		});

		await setPolicy("manual");
		await runNow(person.user._id, schedule._id.toString());
		expect((flags.turn.mock.calls[1][0] as { locals: App.Locals }).locals.scheduledRun).toEqual({
			permissionMode: "ask",
		});
	});

	it("an edit that leaves the mode out keeps the stored one, not the policy's ceiling", async () => {
		await setPolicy("always-allow");
		const schedule = await make({ ...asks(), permissionMode: "ask" });
		const edited = await updateSchedule(person.user._id, schedule._id.toString(), {
			target: asks(),
		});
		expect(edited.target.permissionMode).toBe("ask");
		const loosened = await updateSchedule(person.user._id, schedule._id.toString(), {
			target: { ...asks(), permissionMode: "allow" },
		});
		expect(loosened.target.permissionMode).toBe("allow");
	});

	it("reads a target stored before the mode existed as Ask", () => {
		expect(parseChatTarget({ mode: "continue", conversationId: "abc" })?.permissionMode).toBe(
			"ask"
		);
	});
});

describe("the target", () => {
	it("continues a chat the person owns, and labels it", async () => {
		const check = await executor.validateTarget(
			{ mode: "continue", conversationId: conversationId.toString() },
			{ userId: person.user._id }
		);
		expect(check).toMatchObject({
			ok: true,
			target: { mode: "continue", labels: { conversation: "Weekly notes" } },
		});
		expect(
			await executor.describeTarget((check as { target: Record<string, unknown> }).target, {
				userId: person.user._id,
			})
		).toBe("Chat › Weekly notes");
	});

	it("refuses another person's chat as if it did not exist", async () => {
		const other = await createTestUser();
		const theirs = await seedConversation({}, other);
		const check = await executor.validateTarget(
			{ mode: "continue", conversationId: theirs.toString() },
			{ userId: person.user._id }
		);
		expect(check).toMatchObject({ ok: false, error: "That chat is not one of yours." });
	});

	it("needs a chat to continue, and a chat or a model for new chats", async () => {
		const caller = { userId: person.user._id };
		expect((await executor.validateTarget({ mode: "continue" }, caller)).ok).toBe(false);
		expect((await executor.validateTarget({ mode: "new" }, caller)).ok).toBe(false);
		expect(parseChatTarget({ mode: "new", model: "test-model" })).not.toBeNull();
	});

	it("copies the model of the chat it was made from for new chats, and does not hang on the chat", async () => {
		const check = await executor.validateTarget(
			{ mode: "new", conversationId: conversationId.toString() },
			{ userId: person.user._id }
		);
		expect(check).toMatchObject({ ok: true, target: { mode: "new", model: "test-model" } });
		expect((check as { target: Record<string, unknown> }).target.conversationId).toBeUndefined();
		expect(
			await executor.describeTarget((check as { target: Record<string, unknown> }).target, {
				userId: person.user._id,
			})
		).toBe("New chat each time");
	});

	it("refuses a model the person cannot pick", async () => {
		const check = await executor.validateTarget(
			{ mode: "new", model: "no-such-model" },
			{ userId: person.user._id }
		);
		expect(check).toMatchObject({ ok: false });
	});
});

describe("a run in the same chat", () => {
	it("posts the header and the prompt after the last message, as the schedule's key, unattended", async () => {
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const run = await runNow(person.user._id, schedule._id.toString());

		expect(run.status).toBe("sent");
		expect(run.result).toEqual({
			type: "chat",
			ids: { conversationId: conversationId.toString() },
			label: "Weekly notes",
		});
		expect(flags.turn).toHaveBeenCalledTimes(1);
		const event = flags.turn.mock.calls[0][0] as {
			request: Request;
			locals: App.Locals;
			params: { id: string };
		};
		expect(event.params.id).toBe(conversationId.toString());

		expect(event.locals.token).toBe(ACCESS);
		expect(event.locals.scheduledRun).toEqual({ permissionMode: "ask" });
		expect(event.locals.user?._id.equals(person.user._id)).toBe(true);
		const data = JSON.parse(String((await event.request.formData()).get("data")));
		expect(data.id).toBe("a1");
		expect(data.inputs).toMatch(/^\[Scheduled run of "Weekly news", every Monday at 08:00/);
		expect(data.inputs).toContain("no Python sandbox");
		expect(data.inputs.endsWith("\n\nsummarise the news on X")).toBe(true);
	});

	it("marks the chat unread and tells the person it answered", async () => {
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await runNow(person.user._id, schedule._id.toString());

		expect(
			(await collections.conversations.findOne({ _id: conversationId }))?.scheduledUnread
		).toBe(true);
		expect(flags.notify).toHaveBeenCalledWith(
			person.user._id,
			"scheduleRun",
			expect.objectContaining({
				title: "Scheduled chat answered",
				path: `/conversation/${conversationId.toString()}`,
			})
		);
	});

	it("skips when a turn of that chat is still generating", async () => {
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await collections.turnStates.insertOne({
			_id: new ObjectId(),
			conversationId,
			messageId: "a1",
			status: "running",
			producerId: "g",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const run = await runNow(person.user._id, schedule._id.toString());

		expect(run.status).toBe("skipped-still-running");
		expect(run.result?.ids.conversationId).toBe(conversationId.toString());
		expect(flags.turn).not.toHaveBeenCalled();
	});

	it("does not count a turn record left by a process that died", async () => {
		await collections.turnStates.insertOne({
			_id: new ObjectId(),
			conversationId,
			messageId: "a1",
			status: "running",
			producerId: "g",
			createdAt: new Date(0),
			updatedAt: new Date(Date.now() - 6 * 3600_000),
		});
		expect(await conversationBusy(conversationId, new Date())).toBe(false);
	});

	it("switches the schedule off when its chat was deleted", async () => {
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await collections.conversations.deleteOne({ _id: conversationId });
		const run = await runNow(person.user._id, schedule._id.toString());

		expect(run.status).toBe("failed");
		const after = await getSchedule(person.user._id, schedule._id.toString());
		expect(after.enabled).toBe(false);
		expect(after.disabledReason).toMatch(/was deleted/);
	});

	it("reports sent at once for a turn still going, and announces its end later", async () => {
		chatRunConfig.earlyWindowMs = 10;
		flags.turn.mockImplementation(async () => turnResponse([finished], 200));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const run = await runNow(person.user._id, schedule._id.toString());

		expect(run.status).toBe("sent");
		expect(run.detail).toMatch(/still coming/);
		await vi.waitFor(async () => {
			expect(
				(await collections.conversations.findOne({ _id: conversationId }))?.scheduledUnread
			).toBe(true);
		});
		expect(flags.notify).toHaveBeenCalledTimes(1);
	});
});

describe("a run in a new chat", () => {
	beforeEach(() => {
		flags.create.mockImplementation(async (event: { request: Request }) => {
			const body = (await event.request.json()) as { model: string };
			createdWith.push(body);
			const _id = await seedConversation({ model: body.model, title: "New Chat" });
			return new Response(JSON.stringify({ conversationId: _id.toString() }));
		});
	});

	it("starts a conversation on the schedule's model, titled by the run, and posts into it", async () => {
		const schedule = await make({ mode: "new", model: "other-model" });
		const run = await runNow(person.user._id, schedule._id.toString());

		expect(run).toMatchObject({ status: "sent" });
		const created = flags.create.mock.calls[0][0] as { request: Request; locals: App.Locals };
		expect(created.locals.token).toBe(ACCESS);
		expect(createdWith).toEqual([{ model: "other-model" }]);
		const id = new ObjectId(run.result?.ids.conversationId);
		const conv = await collections.conversations.findOne({ _id: id });
		expect(conv?.title).toMatch(/^Weekly news · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
		expect(conv?.scheduledUnread).toBe(true);
		const turn = flags.turn.mock.calls[0][0] as { params: { id: string } };
		expect(turn.params.id).toBe(id.toString());
	});

	it("skips while the previous run's chat is still generating, and makes no new chat", async () => {
		const schedule = await make({ mode: "new", model: "test-model" });
		const first = await runNow(person.user._id, schedule._id.toString());
		await collections.turnStates.insertOne({
			_id: new ObjectId(),
			conversationId: new ObjectId(first.result?.ids.conversationId),
			messageId: "a1",
			status: "running",
			producerId: "g",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		flags.create.mockClear();
		const second = await runNow(person.user._id, schedule._id.toString());

		expect(second.status).toBe("skipped-still-running");
		expect(flags.create).not.toHaveBeenCalled();
	});
});

describe("when the turn goes wrong", () => {
	it("a 401 from the gateway is an ordinary failed run now: the access is the grant's to lose, not the run's", async () => {
		flags.turn.mockImplementation(async () => turnResponse([failedWith(401, "Unauthorized")]));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const run = await runNow(person.user._id, schedule._id.toString());
		expect(run).toMatchObject({ status: "failed", detail: "Unauthorized" });
		expect((await getSchedule(person.user._id, schedule._id.toString())).enabled).toBe(true);
		expect(await hasGrant(person.user._id)).toBe(true);
	});

	it("a 403 is an ordinary failed run with the gateway's words", async () => {
		flags.turn.mockImplementation(async () =>
			turnResponse([failedWith(403, "Blocked by a redaction policy")])
		);
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const run = await runNow(person.user._id, schedule._id.toString());
		expect(run).toMatchObject({ status: "failed", detail: "Blocked by a redaction policy" });
		expect((await getSchedule(person.user._id, schedule._id.toString())).enabled).toBe(true);
	});

	it("an ordinary error is a failed run, and three in a row switch the schedule off", async () => {
		flags.turn.mockImplementation(async () => turnResponse([failedWith(500, "model exploded")]));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const id = schedule._id.toString();

		const first = await runNow(person.user._id, id);
		expect(first).toMatchObject({ status: "failed", detail: "model exploded" });
		expect((await getSchedule(person.user._id, id)).enabled).toBe(true);
		await runNow(person.user._id, id);
		await runNow(person.user._id, id);
		const after = await getSchedule(person.user._id, id);
		expect(after.enabled).toBe(false);
		expect(after.disabledReason).toMatch(/Switched off after 3 failed runs/);
	});

	it("an error thrown by the route (rate limit) is a failed run with its words", async () => {
		flags.turn.mockRejectedValue({ status: 429, body: { message: "Too many messages" } });
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const run = await runNow(person.user._id, schedule._id.toString());
		expect(run).toMatchObject({ status: "failed", detail: "Too many messages" });
	});

	it("runs with no access token at all off a gateway", async () => {
		flags.gateway = false;
		await collections.scheduleGrants.deleteMany({});
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const run = await runNow(person.user._id, schedule._id.toString());
		expect(run.status).toBe("sent");
		expect((flags.turn.mock.calls[0][0] as { locals: App.Locals }).locals.token).toBeUndefined();
	});
});

describe("a run that outlives its window", () => {
	beforeEach(() => {
		chatRunConfig.earlyWindowMs = 10;
	});

	it("is rewritten to failed when the turn then fails, and counts against the schedule", async () => {
		flags.turn.mockImplementation(async () => turnResponse([failedWith(500, "late boom")], 150));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const run = await runNow(person.user._id, schedule._id.toString());
		expect(run.status).toBe("sent");

		await vi.waitFor(async () => {
			const row = await collections.scheduleRuns.findOne({ _id: run._id });
			expect(row).toMatchObject({ status: "failed", detail: "late boom" });
		});
		const after = await getSchedule(person.user._id, schedule._id.toString());
		expect(after).toMatchObject({ consecutiveFailures: 1, lastStatus: "failed", enabled: true });
	});

	it("three late failures in a row switch the schedule off", async () => {
		flags.turn.mockImplementation(async () => turnResponse([failedWith(500, "late boom")], 30));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		for (let i = 0; i < 3; i++) {
			await runNow(person.user._id, schedule._id.toString());
			await vi.waitFor(async () => {
				expect(
					(await getSchedule(person.user._id, schedule._id.toString())).consecutiveFailures
				).toBe(i + 1);
			});
		}
		const after = await getSchedule(person.user._id, schedule._id.toString());
		expect(after.enabled).toBe(false);
		expect(after.disabledReason).toMatch(/3 failed runs in a row/);
	});

	it("a late success clears the failure count", async () => {
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await collections.schedules.updateOne(
			{ _id: schedule._id },
			{ $set: { consecutiveFailures: 2 } }
		);
		flags.turn.mockImplementation(async () => turnResponse([finished], 100));
		await runNow(person.user._id, schedule._id.toString());
		await vi.waitFor(async () => {
			expect(
				(await getSchedule(person.user._id, schedule._id.toString())).consecutiveFailures
			).toBe(0);
		});
	});

	it("a late 401 is an ordinary late failure too", async () => {
		flags.turn.mockImplementation(async () => turnResponse([failedWith(401, "nope")], 100));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const run = await runNow(person.user._id, schedule._id.toString());
		await vi.waitFor(async () => {
			expect(await collections.scheduleRuns.findOne({ _id: run._id })).toMatchObject({
				status: "failed",
				detail: "nope",
			});
		});
		expect((await getSchedule(person.user._id, schedule._id.toString())).enabled).toBe(true);
	});

	it("never has more scheduled turns running than the cap, and recovers when they end", async () => {
		chatRunConfig.maxConcurrent = 1;
		flags.turn.mockImplementation(async () => turnResponse([finished], 150));
		const a = await make({ mode: "continue", conversationId: conversationId.toString() });
		const otherChat = await seedConversation();
		const b = await make(
			{ mode: "continue", conversationId: otherChat.toString() },
			{ name: "Second" }
		);
		const first = await runNow(person.user._id, a._id.toString());
		expect(first.status).toBe("sent");
		const second = await runNow(person.user._id, b._id.toString());
		expect(second).toMatchObject({ status: "skipped-still-running" });
		expect(second.detail).toMatch(/Too many scheduled chats/);

		await vi.waitFor(async () => {
			const again = await runNow(person.user._id, b._id.toString());
			expect(again.status).toBe("sent");
		});
	});
});

describe("a new chat in a project", () => {
	async function projectFor(owner: typeof person, shares: unknown[] = []) {
		const _id = new ObjectId();
		await collections.projects.insertOne({
			_id,
			userId: owner.user._id,
			name: "Roadmap",
			shares,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		return _id;
	}
	beforeEach(() => {
		flags.create.mockImplementation(async () => {
			const _id = await seedConversation({ title: "New Chat" });
			return new Response(JSON.stringify({ conversationId: _id.toString() }));
		});
	});

	it("runs in a project shared with one of the person's groups, which a groupless check would refuse", async () => {
		const other = await createTestUser();
		const project = await projectFor(other, [{ kind: "group", name: "team" }]);
		flags.groups = ["team"];
		const schedule = await make({
			mode: "new",
			model: "test-model",
			projectId: project.toString(),
		});
		expect((await runNow(person.user._id, schedule._id.toString())).status).toBe("sent");
	});

	it("checks access again at each run: a lost project fails the run and switches the schedule off", async () => {
		const project = await projectFor(person);
		const schedule = await make({
			mode: "new",
			model: "test-model",
			projectId: project.toString(),
		});
		const other = await createTestUser();
		await collections.projects.updateOne({ _id: project }, { $set: { userId: other.user._id } });
		const run = await runNow(person.user._id, schedule._id.toString());

		expect(run.status).toBe("failed");
		expect(run.detail).toMatch(/no longer have access/);
		expect(flags.create).not.toHaveBeenCalled();
		expect((await getSchedule(person.user._id, schedule._id.toString())).enabled).toBe(false);
	});

	it("refuses to make a schedule for a project that is not theirs or shared with them", async () => {
		const other = await createTestUser();
		const project = await projectFor(other);
		await expect(
			make({ mode: "new", model: "test-model", projectId: project.toString() })
		).rejects.toMatchObject({ message: expect.stringContaining("project") });
	});
});

describe("the background grant", () => {
	const continueTarget = () => ({ mode: "continue", conversationId: conversationId.toString() });

	it("is needed to create or switch on a chat schedule, and asked for in the person's words", async () => {
		await collections.scheduleGrants.deleteMany({});
		await expect(make(continueTarget())).rejects.toMatchObject({
			status: 409,
			message: NEEDS_GRANT,
		});
		// Made switched off it needs nothing yet; switching it on does.
		const off = await make(continueTarget(), { enabled: false });
		await expect(
			updateSchedule(person.user._id, off._id.toString(), { enabled: true })
		).rejects.toMatchObject({ status: 409, message: NEEDS_GRANT });
		await giveGrant();
		expect(
			(await updateSchedule(person.user._id, off._id.toString(), { enabled: true })).enabled
		).toBe(true);
	});

	it("is not needed off a gateway", async () => {
		flags.gateway = false;
		await collections.scheduleGrants.deleteMany({});
		expect((await make(continueTarget())).enabled).toBe(true);
	});

	it("runs with an access token refreshed from the grant, reusing it while it lasts", async () => {
		await collections.scheduleGrants.deleteMany({});
		await giveGrant(person, { access: "stale", expiresInMs: 10_000 });
		const schedule = await make(continueTarget());
		await runNow(person.user._id, schedule._id.toString());
		await runNow(person.user._id, schedule._id.toString());

		expect(flags.refresh).toHaveBeenCalledTimes(1);
		expect(flags.refresh.mock.calls[0][1]).toBe("rt-1");
		for (const call of flags.turn.mock.calls) {
			expect((call[0] as { locals: App.Locals }).locals.token).toBe("at-fresh");
		}
	});

	it("keeps the rotated refresh token, sealed, and keeps the old one when the IdP does not rotate", async () => {
		await collections.scheduleGrants.deleteMany({});
		await giveGrant(person, { expiresInMs: 1000 });
		await accessTokenFor(person.user._id);
		let row = await collections.scheduleGrants.findOne({ userId: person.user._id });
		expect(open(row?.refreshSealed ?? "")).toBe("rt-rotated");
		expect(row?.refreshSealed).not.toContain("rt-rotated");

		flags.refresh.mockResolvedValue({
			access_token: "at-2",
			expires_at: Math.floor((Date.now() + 3600_000) / 1000),
		});
		await collections.scheduleGrants.updateOne(
			{ userId: person.user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() - 1000) } }
		);
		expect((await accessTokenFor(person.user._id)).value).toBe("at-2");
		row = await collections.scheduleGrants.findOne({ userId: person.user._id });
		expect(open(row?.refreshSealed ?? "")).toBe("rt-rotated");
	});

	it("serialises concurrent runs per person: one refresh, every run gets a token", async () => {
		await collections.scheduleGrants.deleteMany({});
		await giveGrant(person, { expiresInMs: 1000 });
		flags.refresh.mockImplementation(async () => {
			await new Promise((r) => setTimeout(r, 80));
			return {
				access_token: "at-once",
				refresh_token: "rt-once",
				expires_at: Math.floor((Date.now() + 3600_000) / 1000),
			};
		});
		const tokens = (await Promise.all([1, 2, 3].map(() => accessTokenFor(person.user._id)))).map(
			(t) => t.value
		);
		expect(tokens).toEqual(["at-once", "at-once", "at-once"]);
		expect(flags.refresh).toHaveBeenCalledTimes(1);
	});

	it("invalid_grant drops the grant and switches every chat schedule of theirs off", async () => {
		const a = await make(continueTarget());
		const b = await make(
			{ mode: "continue", conversationId: (await seedConversation()).toString() },
			{ name: "Second" }
		);
		await collections.scheduleGrants.updateOne(
			{ userId: person.user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() - 1000) } }
		);
		flags.refresh.mockRejectedValue(
			Object.assign(new Error("invalid_grant"), { error: "invalid_grant" })
		);
		const run = await runNow(person.user._id, a._id.toString());

		expect(run.status).toBe("failed");
		expect(run.detail).toBe(SIGN_IN_AGAIN);
		expect(await hasGrant(person.user._id)).toBe(false);
		for (const schedule of [a, b]) {
			const after = await getSchedule(person.user._id, schedule._id.toString());
			expect(after).toMatchObject({ enabled: false, disabledReason: SIGN_IN_AGAIN });
		}
		expect(flags.turn).not.toHaveBeenCalled();
		// The refresh token is revoked at the IdP, best effort.
		expect(flags.revoke).toHaveBeenCalled();
	});

	it("an IdP that cannot be reached is an ordinary failed run: the grant and the schedule stay", async () => {
		const schedule = await make(continueTarget());
		await collections.scheduleGrants.updateOne(
			{ userId: person.user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() - 1000) } }
		);
		flags.refresh.mockRejectedValue(new Error("connect ECONNREFUSED"));
		const run = await runNow(person.user._id, schedule._id.toString());

		expect(run.status).toBe("failed");
		expect(run.detail).toContain("ECONNREFUSED");
		expect(await hasGrant(person.user._id)).toBe(true);
		expect((await getSchedule(person.user._id, schedule._id.toString())).enabled).toBe(true);
	});

	it("a grant that went missing switches the schedule off without posting anything", async () => {
		const schedule = await make(continueTarget());
		await collections.scheduleGrants.deleteMany({});
		const run = await runNow(person.user._id, schedule._id.toString());
		expect(run.status).toBe("failed");
		expect(flags.turn).not.toHaveBeenCalled();
		expect((await getSchedule(person.user._id, schedule._id.toString())).enabled).toBe(false);
	});

	it("stops being used by schedules with the last chat schedule, but stays: it keeps the sessions signed in", async () => {
		const a = await make(continueTarget());
		const b = await make(
			{ mode: "continue", conversationId: (await seedConversation()).toString() },
			{ name: "Second" }
		);
		await deleteSchedule(person.user._id, a._id.toString());
		expect(await scheduleGrantUsable(person.user._id)).toBe(true);
		await deleteSchedule(person.user._id, b._id.toString());
		expect(await scheduleGrantUsable(person.user._id)).toBe(false);
		expect(await hasGrant(person.user._id)).toBe(true);
		expect(flags.revoke).not.toHaveBeenCalled();
		// Turning a chat schedule on again gives it back.
		await make(continueTarget());
		expect(await scheduleGrantUsable(person.user._id)).toBe(true);
	});

	it("while stopped a run cannot use it, though sessions still refresh through it", async () => {
		await make(continueTarget());
		await stopScheduleUse(person.user._id);
		await collections.scheduleGrants.updateOne(
			{ userId: person.user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() - 1000) } }
		);
		await expect(accessTokenFor(person.user._id, { forSchedule: true })).rejects.toThrow(
			/background access/
		);
		expect(flags.refresh).not.toHaveBeenCalled();
		expect((await accessTokenFor(person.user._id)).value).toBe("at-fresh");
	});

	it("is not touched by deleting a schedule of another kind", async () => {
		const _id = new ObjectId();
		await collections.schedules.insertOne({
			_id,
			userId: person.user._id,
			kind: "agent",
			name: "agent",
			target: {},
			prompt: "p",
			recurrence: { type: "daily", at: "09:00" },
			timezone: "UTC",
			anchorAt: new Date(),
			enabled: false,
			nextRunAt: null,
			consecutiveFailures: 0,
			firedCount: 0,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		await deleteSchedule(person.user._id, _id.toString());
		expect(await hasGrant(person.user._id)).toBe(true);
		expect(flags.revoke).not.toHaveBeenCalled();
	});
});

describe("when an account goes", () => {
	it("erasing drops the grant (revoked at the IdP) and deletes the schedules", async () => {
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const entries = (await import("$lib/server/identity/userKeyedCollections"))
			.USER_KEYED_COLLECTIONS;
		await entries
			.find((e) => e.name === "scheduleGrants")
			?.erase(person.user._id, { conversationIds: [] });
		await entries
			.find((e) => e.name === "schedules")
			?.erase(person.user._id, { conversationIds: [] });

		expect(await hasGrant(person.user._id)).toBe(false);
		expect(flags.revoke).toHaveBeenCalledTimes(1);
		expect(await collections.schedules.countDocuments({ _id: schedule._id })).toBe(0);
	});

	it("merging drops the stray's grant and switches its chat schedules off, for the target to turn on", async () => {
		const target = await createTestUser();
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const merge = (
			await import("$lib/server/identity/userKeyedCollections")
		).USER_KEYED_COLLECTIONS.find((e) => e.name === "schedules")?.merge;
		await merge?.(person.user._id, target.user._id);

		expect(await hasGrant(person.user._id)).toBe(false);
		const row = await collections.schedules.findOne({ _id: schedule._id });
		expect(row?.userId.equals(target.user._id)).toBe(true);
		expect(row).toMatchObject({ enabled: false, disabledReason: SIGN_IN_AGAIN });
	});
});
