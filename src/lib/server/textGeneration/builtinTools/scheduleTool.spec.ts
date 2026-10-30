/**
 * The `schedule` tool: what a proposal must look like, and that only the person's click on the
 * approval card makes a schedule (through the real resume path), as them, with their own token.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";

const gateway = vi.hoisted(() => ({ on: true }));
vi.mock("$lib/server/identity/gatewayLogin", async (original) => ({
	...(await original<typeof import("$lib/server/identity/gatewayLogin")>()),
	isGatewayPreset: () => gateway.on,
}));
const limits = vi.hoisted(() => ({ enabled: true }));
vi.mock("$lib/server/schedules/limits", async (original) => ({
	...(await original<typeof import("$lib/server/schedules/limits")>()),
	schedulesEnabled: () => limits.enabled,
}));
vi.mock("$lib/server/models", () => ({
	models: [{ id: "test-model" }],
	validateModel: () => null,
}));

import "$lib/server/schedules/chatScheduleExecutor";
import {
	createScheduleFromApproval,
	createScheduleTool,
	parseScheduleToolArgs,
	MAX_ACTIVE_PER_CONVERSATION,
	MAX_ASSISTANT_SCHEDULES_PER_HOUR,
	SCHEDULE_TOOL_NAME,
} from "./scheduleTool";
import { saveGrant } from "$lib/server/schedules/grants";
import { resumeParkedToolCall } from "$lib/server/mcp/resumeElicitation";

await ready;

const proposal = {
	name: "Friday report",
	prompt: "Remind me to send the weekly report.",
	recurrence: { type: "weekly", day: 5, at: "16:00" },
	timezone: "Europe/Rome",
};

describe("parseScheduleToolArgs", () => {
	it("accepts a complete proposal and defaults to continuing this chat", () => {
		const parsed = parseScheduleToolArgs(proposal, {});
		expect(parsed).toMatchObject({
			ok: true,
			value: { name: "Friday report", mode: "continue", timezone: "Europe/Rome" },
		});
	});

	it("takes the person's timezone when the model leaves it out, and UTC when nobody knows it", () => {
		const bare: Partial<typeof proposal> = { ...proposal };
		delete bare.timezone;
		expect(parseScheduleToolArgs(bare, { timezone: "Asia/Tokyo" })).toMatchObject({
			value: { timezone: "Asia/Tokyo" },
		});
		expect(parseScheduleToolArgs(bare, {})).toMatchObject({ value: { timezone: "UTC" } });
	});

	it("refuses what the schedules store would refuse, with the store's words", () => {
		expect(
			parseScheduleToolArgs({ ...proposal, recurrence: { type: "hours", every: 0 } }, {})
		).toMatchObject({ ok: false, error: expect.stringContaining("Every N hours") });
		expect(
			parseScheduleToolArgs({ ...proposal, recurrence: { type: "cron", expr: "* * * * *" } }, {})
		).toMatchObject({ ok: false });
		expect(parseScheduleToolArgs({ ...proposal, timezone: "Mars/Olympus" }, {})).toMatchObject({
			ok: false,
		});
		expect(parseScheduleToolArgs({ ...proposal, name: "" }, {})).toMatchObject({ ok: false });
		expect(parseScheduleToolArgs(null, {})).toMatchObject({ ok: false });
	});

	it("keeps an occurrence cap, for a one-time reminder", () => {
		expect(parseScheduleToolArgs({ ...proposal, maxOccurrences: 1 }, {})).toMatchObject({
			value: { maxOccurrences: 1 },
		});
	});
});

describe("the tool itself", () => {
	const tool = createScheduleTool({});

	it("never creates anything: a valid call is told to wait for the card, an invalid one why not", async () => {
		const ctx = { uuid: "u", toolCallId: "c" };
		const before = await collections.schedules.countDocuments({});
		expect(await tool.execute(proposal, ctx)).toMatchObject({
			error: expect.stringContaining("confirms it"),
		});
		expect(
			await tool.execute({ ...proposal, recurrence: { type: "hours", every: 0 } }, ctx)
		).toMatchObject({ error: expect.stringContaining("Every N hours") });
		expect(await collections.schedules.countDocuments({})).toBe(before);
	});

	it("names itself and asks for the person's timezone", () => {
		expect(tool.name).toBe(SCHEDULE_TOOL_NAME);
		const parameters = tool.definition.function.parameters as { required: string[] };
		expect(parameters.required).toEqual(["name", "prompt", "recurrence", "timezone"]);
	});
});

describe("confirming the card", () => {
	let person: Awaited<ReturnType<typeof createTestUser>>;
	let conversationId: ObjectId;

	beforeEach(async () => {
		await cleanupTestData();
		await collections.schedules.deleteMany({});
		await collections.mcpElicitations.deleteMany({});
		await collections.scheduleGrants.deleteMany({});
		await collections.settings.deleteMany({});
		gateway.on = true;
		limits.enabled = true;
		person = await createTestUser();
		// Background access, as the authorization callback would have saved it.
		await saveGrant(person.user._id, { refresh_token: "rt", access_token: "at" } as never);
		await collections.sessions.updateOne(
			{ sessionId: person.session.sessionId },
			{ $set: { authTime: new Date() } }
		);
		conversationId = new ObjectId();
		await collections.conversations.insertOne({
			_id: conversationId,
			userId: person.user._id,
			title: "Planning",
			model: "test-model",
			rootMessageId: "r",
			messages: [{ id: "r", from: "system", content: "", ancestors: [], children: [] }],
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
	});

	async function parkProposal(action: "accept" | "decline", scope?: "once" | "conversation") {
		const elicitationId = crypto.randomUUID();
		await collections.mcpElicitations.insertOne({
			_id: new ObjectId(),
			elicitationId,
			conversationId,
			status: "resolved",
			action,
			...(scope ? { content: { scope } } : {}),
			request: {
				elicitationId,
				server: "schedule",
				mode: "form",
				message: "The assistant wants to call schedule.",
				fields: [],
				toolApproval: { tool: "schedule", args: proposal },
			},
			pending: {
				kind: "tool-approval",
				tool: "schedule",
				args: proposal,
				queue: [],
				messageId: "m1",
				toolCallId: "c1",
				toolUuid: "u1",
				userId: person.user._id,
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		return elicitationId;
	}

	it("creates the chat schedule as the person, from this conversation, with their own token", async () => {
		const id = await parkProposal("accept", "once");
		const outcome = await resumeParkedToolCall({
			conversationId,
			elicitationId: id,
			token: "session-token",
		});

		const rows = await collections.schedules.find({}).toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "chat",
			name: "Friday report",
			timezone: "Europe/Rome",
			enabled: true,
			target: { mode: "continue", conversationId: conversationId.toString() },
			createdBy: { kind: "chat", conversationId: conversationId.toString(), title: "Planning" },
		});
		expect(rows[0].userId.equals(person.user._id)).toBe(true);
		// Ask: this person is on the manual approval policy, so nothing looser is made.
		expect(rows[0].target).toMatchObject({ permissionMode: "ask" });
		const result = outcome.updates.find((u) => "subtype" in u && u.subtype === "result");
		expect(JSON.stringify(result)).toContain("Created the schedule");
	});

	it("creates nothing when the person declines, and tells the model so", async () => {
		const id = await parkProposal("decline");
		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: id });

		expect(await collections.schedules.countDocuments({})).toBe(0);
		expect(outcome.updates.find((u) => "subtype" in u && u.subtype === "error")).toMatchObject({
			message: expect.stringContaining("declined"),
		});
	});

	it("never grants the tool for the rest of the conversation, whatever scope the click carried", async () => {
		const id = await parkProposal("accept", "conversation");
		const outcome = await resumeParkedToolCall({
			conversationId,
			elicitationId: id,
			token: "session-token",
		});

		expect(outcome.grantedTools ?? []).toEqual([]);
		const conv = await collections.conversations.findOne({ _id: conversationId });
		expect(conv?.approvedTools ?? []).toEqual([]);
	});

	it("tells the model why when the schedule cannot be made, and makes nothing", async () => {
		await collections.scheduleGrants.deleteMany({});
		const id = await parkProposal("accept", "once");
		const outcome = await resumeParkedToolCall({
			conversationId,
			elicitationId: id,
			token: "session-token",
		});

		expect(await collections.schedules.countDocuments({})).toBe(0);
		expect(outcome.updates.find((u) => "subtype" in u && u.subtype === "error")).toMatchObject({
			message: expect.stringContaining("background access"),
		});
	});

	describe("the permission mode on the card", () => {
		const withMode = (mode: string) => ({ ...proposal, permissionMode: mode });
		const makeWith = async (args: Record<string, unknown>, conversation: object = {}) => {
			await collections.conversations.updateOne({ _id: conversationId }, { $set: conversation });
			const made = await createScheduleFromApproval({
				args,
				conversationId,
				userId: person.user._id,
				token: "t",
			});
			expect(made).toHaveProperty("text");
			return (await collections.schedules.findOne({}))?.target.permissionMode;
		};
		const setPolicy = (policy: "always-allow" | "manual") =>
			collections.settings.updateOne(
				{ userId: person.user._id },
				{ $set: { toolApprovalPolicy: policy, createdAt: new Date(), updatedAt: new Date() } },
				{ upsert: true }
			);

		it("is Ask by default, and a proposed Allow is made Ask for a person on manual", async () => {
			expect(await makeWith(proposal)).toBe("ask");
			await collections.schedules.deleteMany({});
			expect(await makeWith(withMode("allow"))).toBe("ask");
		});

		it("is Allow only when the person's setting and the conversation both are always-allow", async () => {
			await setPolicy("always-allow");
			expect(await makeWith(withMode("allow"), { toolApprovalOverride: "always-allow" })).toBe(
				"allow"
			);
			await collections.schedules.deleteMany({});
			// This chat is on manual: no looser than the conversation's.
			expect(await makeWith(withMode("allow"), { toolApprovalOverride: "manual" })).toBe("ask");
			await collections.schedules.deleteMany({});
			expect(await makeWith(withMode("ask"), { toolApprovalOverride: "always-allow" })).toBe("ask");
		});
	});

	it("applies the API's gates: the switch, and a sign-in within 7 days", async () => {
		limits.enabled = false;
		expect(
			await createScheduleFromApproval({
				args: proposal,
				conversationId,
				userId: person.user._id,
				token: "t",
			})
		).toMatchObject({ error: expect.stringContaining("switched off") });
		limits.enabled = true;

		await collections.sessions.updateOne(
			{ sessionId: person.session.sessionId },
			{ $set: { authTime: new Date(Date.now() - 8 * 24 * 3600_000) } }
		);
		expect(
			await createScheduleFromApproval({
				args: proposal,
				conversationId,
				userId: person.user._id,
				token: "t",
			})
		).toMatchObject({ error: expect.stringContaining("older than 7 days") });
		expect(await collections.schedules.countDocuments({})).toBe(0);
	});

	it("makes at most three running schedules per conversation", async () => {
		const make = () =>
			createScheduleFromApproval({
				args: proposal,
				conversationId,
				userId: person.user._id,
				token: "t",
			});
		for (let i = 0; i < MAX_ACTIVE_PER_CONVERSATION; i++)
			expect(await make()).toHaveProperty("text");
		expect(await make()).toMatchObject({ error: expect.stringContaining("already has 3 running") });
		// Switching one off makes room.
		await collections.schedules.updateOne({}, { $set: { enabled: false } });
		expect(await make()).toHaveProperty("text");
	});

	it("makes at most ten in an hour for one person, across conversations", async () => {
		for (let i = 0; i < MAX_ASSISTANT_SCHEDULES_PER_HOUR; i++) {
			const c = new ObjectId();
			await collections.conversations.insertOne({
				_id: c,
				userId: person.user._id,
				title: `c${i}`,
				model: "test-model",
				rootMessageId: "r",
				messages: [],
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never);
			expect(
				await createScheduleFromApproval({
					args: proposal,
					conversationId: c,
					userId: person.user._id,
					token: "t",
				})
			).toHaveProperty("text");
		}
		expect(
			await createScheduleFromApproval({
				args: proposal,
				conversationId,
				userId: person.user._id,
				token: "t",
			})
		).toMatchObject({ error: expect.stringContaining("last hour") });
	});

	it("refuses a conversation that is not the person's", async () => {
		const other = await createTestUser();
		await collections.sessions.updateOne(
			{ sessionId: other.session.sessionId },
			{ $set: { authTime: new Date() } }
		);
		expect(
			await createScheduleFromApproval({
				args: proposal,
				conversationId,
				userId: other.user._id,
				token: "t",
			})
		).toMatchObject({ error: "The conversation this was proposed in is gone." });
		expect(
			await createScheduleFromApproval({
				args: proposal,
				conversationId,
				userId: undefined,
				token: "t",
			})
		).toMatchObject({ error: expect.stringContaining("signed-in") });
	});
});
