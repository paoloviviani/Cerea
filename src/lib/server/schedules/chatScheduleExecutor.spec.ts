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
import { open, seal } from "$lib/server/mcp/secretBox";

const flags = vi.hoisted(() => ({
	gateway: true,
	mint: vi.fn(),
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
vi.mock("./gatewayKeys", () => ({
	mintKey: (...args: unknown[]) => flags.mint(...args),
	revokeKey: (...args: unknown[]) => flags.revoke(...args),
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
import {
	chatRunConfig,
	conversationBusy,
	parseChatTarget,
	SIGN_IN_AGAIN,
} from "./chatScheduleExecutor";
import { getExecutor } from "./executors";
import { runNow } from "./scheduler";
import { renewKeys, KEY_LIFETIME_DAYS } from "./chatScheduleExecutor";
import { retryRevocations, revokeAllFor } from "./credentials";
import { createSchedule, deleteSchedule, getSchedule, updateSchedule } from "./store";
import type { Schedule } from "$lib/types/Schedule";

await ready;

const executor = getExecutor("chat");
if (!executor) throw new Error("the chat executor did not register");

const KEY = "sk-test-secret";

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
	await collections.scheduleKeyRevocations.deleteMany({});
	await collections.projects.deleteMany({});
	flags.groups = [];
	chatRunConfig.maxConcurrent = 4;
	vi.clearAllMocks();
	createdWith.length = 0;
	flags.gateway = true;
	chatRunConfig.earlyWindowMs = 5_000;
	flags.mint.mockResolvedValue({ id: "key-1", secret: KEY });
	flags.revoke.mockResolvedValue(true);
	flags.turn.mockImplementation(async () => turnResponse([finished]));
	person = await createTestUser();
	conversationId = await seedConversation();
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
		expect(event.locals.scheduledRun).toBe(true);
		expect(event.locals.token).toBe(KEY);
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
		expect(created.locals.token).toBe(KEY);
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
	it("a refusal by the gateway disables the schedule with a reason and forgets the key", async () => {
		flags.turn.mockImplementation(async () => turnResponse([failedWith(401, "Unauthorized")]));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		expect(schedule.credential).toBeDefined();
		const run = await runNow(person.user._id, schedule._id.toString());

		expect(run.status).toBe("failed");
		const after = await getSchedule(person.user._id, schedule._id.toString());
		expect(after.enabled).toBe(false);
		expect(after.disabledReason).toBe(SIGN_IN_AGAIN);
		expect(after.credential).toBeUndefined();
	});

	it("a 403 is not a dead key: it is an ordinary failed run with the gateway's words, and the key stays", async () => {
		flags.turn.mockImplementation(async () =>
			turnResponse([failedWith(403, "Blocked by a redaction policy")])
		);
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const run = await runNow(person.user._id, schedule._id.toString());

		expect(run).toMatchObject({ status: "failed", detail: "Blocked by a redaction policy" });
		const after = await getSchedule(person.user._id, schedule._id.toString());
		expect(after.enabled).toBe(true);
		expect(after.credential?.keyId).toBe("key-1");
		expect(flags.revoke).not.toHaveBeenCalled();
	});

	it("a message that merely mentions 403 is not a refusal of the key either", async () => {
		flags.turn.mockImplementation(async () =>
			turnResponse([failedWith(undefined, "model 403 returned")])
		);
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await runNow(person.user._id, schedule._id.toString());
		expect((await getSchedule(person.user._id, schedule._id.toString())).enabled).toBe(true);
	});

	it("a dead key is revoked (or queued for revoking) before it is forgotten", async () => {
		flags.revoke.mockResolvedValue(false);
		flags.turn.mockImplementation(async () => turnResponse([failedWith(401)]));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await runNow(person.user._id, schedule._id.toString());

		expect(flags.revoke).toHaveBeenCalled();
		expect(await collections.scheduleKeyRevocations.countDocuments({ keyId: "key-1" })).toBe(1);
	});

	it("does not switch off a schedule whose key was replaced while the run was going", async () => {
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		flags.turn.mockImplementation(async () => {
			// An edit mints a fresh key while this run's request is out.
			await collections.schedules.updateOne(
				{ _id: schedule._id },
				{ $set: { "credential.keyId": "key-NEW" } }
			);
			return turnResponse([failedWith(401)]);
		});
		await runNow(person.user._id, schedule._id.toString());

		const after = await getSchedule(person.user._id, schedule._id.toString());
		expect(after.enabled).toBe(true);
		expect(after.credential?.keyId).toBe("key-NEW");
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
		expect(after.credential).toBeDefined();
	});

	it("an error thrown by the route (rate limit) is a failed run with its words", async () => {
		flags.turn.mockRejectedValue({ status: 429, body: { message: "Too many messages" } });
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const run = await runNow(person.user._id, schedule._id.toString());
		expect(run).toMatchObject({ status: "failed", detail: "Too many messages" });
	});

	it("a schedule with no key on a gateway is switched off without posting anything", async () => {
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await collections.schedules.updateOne({ _id: schedule._id }, { $unset: { credential: "" } });
		const run = await runNow(person.user._id, schedule._id.toString());

		expect(run.status).toBe("failed");
		expect(flags.turn).not.toHaveBeenCalled();
		expect((await getSchedule(person.user._id, schedule._id.toString())).disabledReason).toBe(
			SIGN_IN_AGAIN
		);
	});

	it("runs with no key at all off a gateway", async () => {
		flags.gateway = false;
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		expect(schedule.credential).toBeUndefined();
		expect(flags.mint).not.toHaveBeenCalled();
		const run = await runNow(person.user._id, schedule._id.toString());
		expect(run.status).toBe("sent");
		expect((flags.turn.mock.calls[0][0] as { locals: App.Locals }).locals.token).toBeUndefined();
	});
});

describe("the key lifecycle", () => {
	it("is minted with the person's session on create, named for the schedule, and sealed", async () => {
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });

		// Valid for 180 days, so a forgotten key cannot live for ever.
		expect(flags.mint).toHaveBeenCalledWith({
			token: "session-token",
			name: "Cerea schedule: Weekly news",
			expiresInDays: 180,
		});
		const stored = await collections.schedules.findOne({ _id: schedule._id });
		expect(stored?.credential?.keyId).toBe("key-1");
		expect(stored?.credential?.sealed).not.toContain(KEY);
		expect(open(stored?.credential?.sealed ?? "")).toBe(KEY);
	});

	it("uses the billing group the person's settings name, when it is one", async () => {
		const group = "8f0f3c5e-1111-4222-8333-944455556666";
		await collections.settings.insertOne({
			_id: new ObjectId(),
			userId: person.user._id,
			billingOrganization: group,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		await make({ mode: "continue", conversationId: conversationId.toString() });
		expect(flags.mint).toHaveBeenCalledWith(expect.objectContaining({ billingGroupId: group }));
	});

	it("is not minted for a schedule made switched off, and is minted when it is switched on", async () => {
		const { updateSchedule } = await import("./store");
		const schedule = await make(
			{ mode: "continue", conversationId: conversationId.toString() },
			{ enabled: false }
		);
		expect(flags.mint).not.toHaveBeenCalled();
		const on = await updateSchedule(
			person.user._id,
			schedule._id.toString(),
			{ enabled: true },
			{
				token: "session-token",
			}
		);
		expect(flags.mint).toHaveBeenCalledTimes(1);
		expect(on.credential?.keyId).toBe("key-1");
	});

	it("keeps the key when the schedule is turned off and on again", async () => {
		const { updateSchedule } = await import("./store");
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const id = schedule._id.toString();
		await updateSchedule(person.user._id, id, { enabled: false }, { token: "session-token" });
		await updateSchedule(person.user._id, id, { enabled: true }, { token: "session-token" });

		expect(flags.mint).toHaveBeenCalledTimes(1);
		expect(flags.revoke).not.toHaveBeenCalled();
	});

	it("mints a fresh key when a dead one was forgotten, and revokes the one it replaces", async () => {
		const { updateSchedule } = await import("./store");
		flags.turn.mockImplementation(async () => turnResponse([failedWith(401)]));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const id = schedule._id.toString();
		await runNow(person.user._id, id);
		// The dead key was revoked when it was dropped (and is not revoked a second time).
		expect(flags.revoke).toHaveBeenCalledTimes(1);
		flags.revoke.mockClear();
		flags.mint.mockResolvedValue({ id: "key-2", secret: "sk-second" });
		const again = await updateSchedule(
			person.user._id,
			id,
			{ enabled: true },
			{
				token: "fresh-session",
			}
		);

		expect(flags.mint).toHaveBeenLastCalledWith(
			expect.objectContaining({ token: "fresh-session" })
		);
		expect(again.credential?.keyId).toBe("key-2");
		expect(again.disabledReason).toBeUndefined();
		// The dropped key was already dealt with, so there is nothing left to revoke.
		expect(flags.revoke).not.toHaveBeenCalled();
	});

	it("is revoked, with the person's session, when the schedule is deleted", async () => {
		const { deleteSchedule } = await import("./store");
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await deleteSchedule(person.user._id, schedule._id.toString(), { token: "session-token" });

		expect(flags.revoke).toHaveBeenCalledWith({ token: "session-token", keyId: "key-1" });
		expect(await collections.schedules.countDocuments({ _id: schedule._id })).toBe(0);
	});

	it("is revoked with the key itself when there is no session, and a failed revoke does not keep the schedule", async () => {
		const { deleteSchedule } = await import("./store");
		flags.revoke.mockResolvedValue(false);
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await deleteSchedule(person.user._id, schedule._id.toString());

		expect(flags.revoke).toHaveBeenCalledWith({ token: KEY, keyId: "key-1" });
		expect(await collections.schedules.countDocuments({ _id: schedule._id })).toBe(0);
	});

	it("a refused mint creates nothing and says why", async () => {
		const { CredentialError } = await import("./executors");
		flags.mint.mockRejectedValue(new CredentialError(403, "Your account may not create keys."));
		await expect(
			make({ mode: "continue", conversationId: conversationId.toString() })
		).rejects.toMatchObject({ status: 403, message: "Your account may not create keys." });
		expect(await collections.schedules.countDocuments({ userId: person.user._id })).toBe(0);
	});

	it("without a session there is no key to make", async () => {
		const real = await vi.importActual<typeof import("./gatewayKeys")>("./gatewayKeys");
		expect(real.mintKey).toBeTypeOf("function");
		flags.mint.mockImplementation(async () => {
			throw new Error("mintKey must not be called without a token");
		});
		await expect(
			createSchedule(person.user._id, {
				name: "No session",
				kind: "chat",
				prompt: "p",
				recurrence: { type: "daily", at: "09:00" },
				timezone: "UTC",
				target: { mode: "continue", conversationId: conversationId.toString() },
			})
		).rejects.toMatchObject({ status: 403 });
		expect(flags.mint).not.toHaveBeenCalled();
	});

	it("makes no key at the gateway when the deployment cannot seal one", async () => {
		const saved = process.env.CHAT_SECRET_KEY;
		delete process.env.CHAT_SECRET_KEY;
		try {
			await expect(
				make({ mode: "continue", conversationId: conversationId.toString() })
			).rejects.toMatchObject({ status: 400, message: expect.stringContaining("CHAT_SECRET_KEY") });
			expect(flags.mint).not.toHaveBeenCalled();
		} finally {
			process.env.CHAT_SECRET_KEY = saved;
		}
	});

	it("seals what it stores so the secret is not readable in the row", () => {
		expect(seal(KEY)).not.toContain(KEY);
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

	it("a late 401 switches the schedule off and revokes the key", async () => {
		flags.turn.mockImplementation(async () => turnResponse([failedWith(401)], 100));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await runNow(person.user._id, schedule._id.toString());
		await vi.waitFor(async () => {
			expect((await getSchedule(person.user._id, schedule._id.toString())).enabled).toBe(false);
		});
		const after = await getSchedule(person.user._id, schedule._id.toString());
		expect(after.credential).toBeUndefined();
		expect(after.disabledReason).toBe(SIGN_IN_AGAIN);
		expect(flags.revoke).toHaveBeenCalled();
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

describe("renewing, queueing and racing keys", () => {
	const DAY = 24 * 3600_000;

	async function withSession(token: string | null) {
		await collections.sessions.updateOne(
			{ sessionId: person.session.sessionId },
			{
				$set: token
					? { oauth: { token: { value: token, expiresAt: new Date(Date.now() + DAY) } } }
					: {},
			}
		);
	}

	it("sends the key's lifetime and records when it ends", async () => {
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const end = schedule.credential?.expiresAt?.getTime() ?? 0;
		expect(Math.abs(end - (Date.now() + KEY_LIFETIME_DAYS * DAY))).toBeLessThan(60_000);
	});

	it("renews a key within 14 days of its end with the person's session, and revokes the old one", async () => {
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await collections.schedules.updateOne(
			{ _id: schedule._id },
			{ $set: { "credential.expiresAt": new Date(Date.now() + 5 * DAY) } }
		);
		await withSession("fresh-session-token");
		flags.mint.mockResolvedValue({ id: "key-2", secret: "sk-second" });

		expect(await renewKeys(new Date())).toBe(1);
		const after = await getSchedule(person.user._id, schedule._id.toString());
		expect(after.credential?.keyId).toBe("key-2");
		expect(open(after.credential?.sealed ?? "")).toBe("sk-second");
		expect(flags.mint).toHaveBeenLastCalledWith(
			expect.objectContaining({ token: "fresh-session-token", expiresInDays: 180 })
		);
		expect(flags.revoke).toHaveBeenCalledWith({ token: "fresh-session-token", keyId: "key-1" });
	});

	it("leaves a key alone that has time left, or when nobody's session can make a new one", async () => {
		const young = await make({ mode: "continue", conversationId: conversationId.toString() });
		expect(await renewKeys(new Date())).toBe(0);
		await collections.schedules.updateOne(
			{ _id: young._id },
			{ $set: { "credential.expiresAt": new Date(Date.now() + 2 * DAY) } }
		);
		await withSession(null);
		expect(await renewKeys(new Date())).toBe(0);
		expect((await getSchedule(person.user._id, young._id.toString())).credential?.keyId).toBe(
			"key-1"
		);
	});

	it("queues a revoke the gateway could not confirm, and retries it until it is gone", async () => {
		flags.revoke.mockResolvedValue(false);
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await deleteSchedule(person.user._id, schedule._id.toString(), { token: "session-token" });

		const queued = await collections.scheduleKeyRevocations.find({}).toArray();
		expect(queued).toHaveLength(1);
		expect(queued[0]).toMatchObject({ keyId: "key-1", attempts: 1 });
		expect(queued[0].sealed).not.toContain(KEY);

		// Not due yet: nothing is tried.
		flags.revoke.mockClear();
		expect(await retryRevocations(new Date())).toBe(0);
		expect(flags.revoke).not.toHaveBeenCalled();

		// Still down: it backs off and stays.
		const later = new Date(Date.now() + 2 * 3600_000);
		expect(await retryRevocations(later)).toBe(0);
		expect(await collections.scheduleKeyRevocations.countDocuments({})).toBe(1);
		expect((await collections.scheduleKeyRevocations.findOne({}))?.attempts).toBe(2);

		// Back up: it is revoked with the key's own secret and the row goes.
		flags.revoke.mockResolvedValue(true);
		const muchLater = new Date(Date.now() + 3 * 24 * 3600_000);
		expect(await retryRevocations(muchLater)).toBe(1);
		expect(flags.revoke).toHaveBeenLastCalledWith({ token: KEY, keyId: "key-1" });
		expect(await collections.scheduleKeyRevocations.countDocuments({})).toBe(0);
	});

	it("two edits that both mint cannot both win: the loser's key is revoked", async () => {
		const schedule = await make(
			{ mode: "continue", conversationId: conversationId.toString() },
			{ enabled: false }
		);
		let n = 0;
		flags.mint.mockImplementation(async () => {
			const mine = ++n;
			await new Promise((r) => setTimeout(r, 30));
			return { id: `race-${mine}`, secret: `sk-race-${mine}` };
		});
		const id = schedule._id.toString();
		const results = await Promise.allSettled([
			updateSchedule(person.user._id, id, { enabled: true }, { token: "t1" }),
			updateSchedule(person.user._id, id, { enabled: true }, { token: "t2" }),
		]);

		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(results.find((r) => r.status === "rejected")).toMatchObject({
			reason: { status: 409 },
		});
		const kept = (await getSchedule(person.user._id, id)).credential?.keyId;
		const revoked = flags.revoke.mock.calls.map((c) => (c[0] as { keyId: string }).keyId);
		expect(revoked).toHaveLength(1);
		expect(revoked).not.toContain(kept);
	});
});

describe("when an account goes", () => {
	it("erasing revokes each schedule's key before the rows are deleted", async () => {
		const { erase } = await import("$lib/server/identity/userKeyedCollections").then((m) => ({
			erase: m.USER_KEYED_COLLECTIONS.find((e) => e.name === "schedules")?.erase,
		}));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await erase?.(person.user._id, { conversationIds: [] });

		expect(flags.revoke).toHaveBeenCalledWith(expect.objectContaining({ keyId: "key-1" }));
		expect(await collections.schedules.countDocuments({ _id: schedule._id })).toBe(0);
	});

	it("a key that cannot be revoked on erasure is queued: the queue outlives the account", async () => {
		flags.revoke.mockResolvedValue(false);
		await make({ mode: "continue", conversationId: conversationId.toString() });
		await revokeAllFor(person.user._id, { disable: false });
		expect(await collections.scheduleKeyRevocations.countDocuments({ keyId: "key-1" })).toBe(1);
	});

	it("merging revokes the stray's keys and switches its chat schedules off, for the target to turn on", async () => {
		const target = await createTestUser();
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		const merge = (
			await import("$lib/server/identity/userKeyedCollections")
		).USER_KEYED_COLLECTIONS.find((e) => e.name === "schedules")?.merge;
		await merge?.(person.user._id, target.user._id);

		expect(flags.revoke).toHaveBeenCalledWith(expect.objectContaining({ keyId: "key-1" }));
		const row = await collections.schedules.findOne({ _id: schedule._id });
		expect(row?.userId.equals(target.user._id)).toBe(true);
		expect(row).toMatchObject({ enabled: false, disabledReason: SIGN_IN_AGAIN });
		expect(row?.credential).toBeUndefined();
	});
});
