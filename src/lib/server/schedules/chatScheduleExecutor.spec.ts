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
import { createSchedule, getSchedule } from "./store";
import type { Schedule } from "$lib/types/Schedule";

await ready;

const executor = getExecutor("chat");
if (!executor) throw new Error("the chat executor did not register");

const KEY = "sk-test-secret";

/** A turn's wire answer: JSON lines, as the conversation route writes them. */
function turnResponse(events: object[], delayMs = 0): Response {
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
			for (const event of events) {
				controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
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

	it("a 403 is the same", async () => {
		flags.turn.mockImplementation(async () => turnResponse([failedWith(403)]));
		const schedule = await make({ mode: "continue", conversationId: conversationId.toString() });
		await runNow(person.user._id, schedule._id.toString());
		expect((await getSchedule(person.user._id, schedule._id.toString())).enabled).toBe(false);
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

		expect(flags.mint).toHaveBeenCalledWith({
			token: "session-token",
			name: "Cerea schedule: Weekly news",
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
		// The dead key was dropped from the row, so there was nothing left to revoke.
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
