import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { MessageUpdateStatus, MessageUpdateType } from "$lib/types/MessageUpdate";

// The sweeper's happy path continues the turn through `textGeneration` once the
// deny is recorded; that pipeline is exercised elsewhere (replayRoundTrip.spec.ts).
// Here it is a black box so the test can assert what the sweeper itself is
// responsible for: claiming, denying, and feeding the refusal into the message.
const seen = vi.hoisted(() => ({ locals: [] as unknown[] }));

vi.mock("$lib/server/textGeneration", () => ({
	async *textGeneration(ctx: { locals: unknown }) {
		seen.locals.push(ctx.locals);
		yield { type: MessageUpdateType.Status, status: MessageUpdateStatus.Finished };
	},
}));

const { sweepExpiredToolApprovals } = await import("./toolApprovalSweeper");

const MODEL_ID = "test-org/test-model";

// The real, shared test database also serves other spec files' concurrent
// workers — a blanket `deleteMany({})` here would wipe conversations another
// file is mid-turn on. Track exactly what this file creates and clean up only
// that.
const createdConversationIds: ObjectId[] = [];

async function seedParkedConversation(params: {
	elicitationId: string;
	expiresAt: Date;
	status?: "pending" | "resolved";
	mcpSelection?: { connectorIds: string[]; customServers: { name: string; url: string }[] };
}) {
	const conversationId = new ObjectId();
	const messageId = "assistant-1";
	await collections.conversations.insertOne({
		_id: conversationId,
		sessionId: "test-session",
		model: MODEL_ID,
		title: "t",
		rootMessageId: "u1",
		messages: [
			{ id: "u1", from: "user", content: "go", ancestors: [], children: [messageId] },
			{
				id: messageId,
				from: "assistant",
				content: "",
				updates: [],
				ancestors: ["u1"],
				children: [],
			},
		],
		...(params.mcpSelection ? { mcpSelection: params.mcpSelection } : {}),
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);

	await collections.mcpElicitations.insertOne({
		_id: new ObjectId(),
		elicitationId: params.elicitationId,
		conversationId,
		status: params.status ?? "pending",
		request: {
			elicitationId: params.elicitationId,
			server: "web_fetch",
			mode: "form",
			message: "Call web_fetch?",
			fields: [],
			toolApproval: { tool: "web_fetch", args: { url: "https://unseen.test/page" } },
		},
		expiresAt: params.expiresAt,
		pending: {
			kind: "tool-approval",
			tool: "web_fetch",
			args: { url: "https://unseen.test/page" },
			queue: [],
			messageId,
			toolCallId: "call-1",
			toolUuid: "uuid-1",
			sessionId: "test-session",
		},
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);

	createdConversationIds.push(conversationId);
	return { conversationId, messageId };
}

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	const ids = createdConversationIds.splice(0);
	if (ids.length === 0) return;
	await collections.mcpElicitations.deleteMany({ conversationId: { $in: ids } });
	await collections.conversations.deleteMany({ _id: { $in: ids } });
	await collections.turnStates.deleteMany({ conversationId: { $in: ids } });
	await collections.generations.deleteMany({ conversationId: { $in: ids } });
	// generationEvents are keyed by generationId (random per run, never reused
	// across files) and asserted by nothing here; left for TTL/db cleanup.
});

describe("sweepExpiredToolApprovals (ADR 0075 deny-timeout)", () => {
	it("denies an expired prompt and feeds the refusal back into the message", async () => {
		const elicitationId = crypto.randomUUID();
		const { conversationId, messageId } = await seedParkedConversation({
			elicitationId,
			expiresAt: new Date(Date.now() - 1_000),
		});

		await sweepExpiredToolApprovals();

		const row = await collections.mcpElicitations.findOne({ elicitationId });
		expect(row?.status).toBe("resolved");
		expect(row?.action).toBe("decline");

		const conv = await collections.conversations.findOne({ _id: conversationId });
		const message = conv?.messages.find((m) => m.id === messageId);
		const errorUpdate = message?.updates?.find(
			(u) => u.type === MessageUpdateType.Tool && u.subtype === "error"
		);
		expect(errorUpdate).toMatchObject({ message: expect.stringContaining("declined") });

		// The turn was continued and closed, not left "awaiting_input" forever —
		// nobody is watching, and the sweeper's job is to unstick it.
		const state = await collections.turnStates.findOne({ conversationId });
		expect(state?.status).toBe("done");
	});

	it("continues the turn with the MCP servers it was started with", async () => {
		// Without this the rounds after the refusal ran with the built-in tools
		// only, as every resumed turn did.
		seen.locals.length = 0;
		const elicitationId = crypto.randomUUID();
		await seedParkedConversation({
			elicitationId,
			expiresAt: new Date(Date.now() - 1_000),
			mcpSelection: {
				connectorIds: [],
				customServers: [{ name: "adhoc", url: "https://adhoc.test/mcp" }],
			},
		});

		await sweepExpiredToolApprovals();

		expect(seen.locals).toHaveLength(1);
		const mcp = (seen.locals[0] as { mcp?: { selectedServers: { name: string }[] } }).mcp;
		expect(mcp?.selectedServers.map((server) => server.name)).toEqual(["adhoc"]);
	});

	it("leaves a not-yet-expired prompt alone", async () => {
		const elicitationId = crypto.randomUUID();
		await seedParkedConversation({ elicitationId, expiresAt: new Date(Date.now() + 60_000) });

		await sweepExpiredToolApprovals();

		const row = await collections.mcpElicitations.findOne({ elicitationId });
		expect(row?.status).toBe("pending");
	});

	it("never touches a prompt someone already answered", async () => {
		const elicitationId = crypto.randomUUID();
		await seedParkedConversation({
			elicitationId,
			expiresAt: new Date(Date.now() - 1_000),
			status: "resolved",
		});

		await sweepExpiredToolApprovals();

		// The CAS on `status: "pending"` misses an already-resolved row: sweeping
		// it again must never overwrite a real answer with a manufactured denial.
		const row = await collections.mcpElicitations.findOne({ elicitationId });
		expect(row?.action).toBeUndefined();
	});
});
