/**
 * A parked turn resumes with the connectors it started with.
 *
 * The defect: `execute_code` parks the turn while the browser runs the code,
 * and the sweeper resumes it with no request to read a selection from. It
 * rebuilt the identity but not `locals.mcp`, so every round after the first
 * `execute_code` ran with the five built-in tools only — a Joplin
 * `update_note` in the same turn was simply not there, and the model spent the
 * step budget loading skills looking for it.
 *
 * `textGeneration` is replaced by a probe that records the context it was
 * handed; everything before it — the conversation, the connector, its sealed
 * token, the selection recorded on the conversation — is real.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const seen = vi.hoisted(() => ({ locals: [] as unknown[] }));

vi.mock("$lib/server/textGeneration", () => ({
	async *textGeneration (ctx: { locals: unknown }) {
		seen.locals.push(ctx.locals);
	},
}));

vi.mock("$lib/server/models", () => ({
	models: [{ id: "test/model", name: "test/model", parameters: {}, getEndpoint: async () => ({}) }],
}));

import { collections, ready } from "$lib/server/database";
import { seal } from "$lib/server/mcp/secretBox";
import { sweepParkedCalls } from "./parkedSweeper";
import type { ParkedCall } from "$lib/types/ParkedCall";

const originalKey = process.env.CHAT_SECRET_KEY;
const userId = new ObjectId();
const conversationId = new ObjectId();
const connectorId = new ObjectId();

beforeAll(async () => {
	await ready;
	process.env.CHAT_SECRET_KEY ||= "parked-sweeper-mcp-spec";
});

afterEach(async () => {
	seen.locals.length = 0;
	await collections.parkedCalls.deleteMany({});
	await collections.turnStates.deleteMany({});
	await collections.conversations.deleteMany({ _id: conversationId });
	await collections.mcpConnectors.deleteMany({ _id: connectorId });
});

afterAll(() => {
	if (originalKey === undefined) delete process.env.CHAT_SECRET_KEY;
	else process.env.CHAT_SECRET_KEY = originalKey;
});

async function seedParkedTurn(mcpSelection?: Record<string, unknown>) {
	await collections.mcpConnectors.insertOne({
		_id: connectorId,
		userId,
		scope: "user",
		name: "Joplin",
		url: "https://joplin.test/mcp",
		auth: "token",
		tokenSealed: seal("joplin-token"),
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	await collections.conversations.insertOne({
		_id: conversationId,
		userId,
		model: "test/model",
		title: "parked with a connector",
		rootMessageId: "sys",
		messages: [
			{ id: "sys", from: "system", content: "", children: ["user-1"] },
			{
				id: "user-1",
				from: "user",
				content: "update the note",
				ancestors: ["sys"],
				children: ["asst-1"],
			},
			{ id: "asst-1", from: "assistant", content: "", ancestors: ["sys", "user-1"], children: [] },
		],
		...(mcpSelection ? { mcpSelection } : {}),
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	const park: ParkedCall = {
		_id: new ObjectId(),
		parkedCallId: new ObjectId().toString(),
		conversationId,
		messageId: "asst-1",
		toolCallId: "call-1",
		toolUuid: "uuid-1",
		kind: "code",
		status: "waiting",
		resumeAt: new Date(Date.now() - 1_000),
		reason: "code execution in the person's browser",
		code: "print(1)",
		outcome: { stdout: "1\n", stderr: "", result: null, files: [] } as never,
		userId,
		attempts: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	await collections.parkedCalls.insertOne(park);
}

type SeenLocals = {
	mcp?: { selectedServers: { name: string; url: string; headers?: Record<string, string> }[] };
};

describe("resuming a parked turn", () => {
	it("restores the turn's connectors, with their credential, after execute_code", async () => {
		await seedParkedTurn({
			connectorIds: [connectorId.toString()],
			customServers: [{ name: "adhoc", url: "https://adhoc.test/mcp" }],
		});

		await sweepParkedCalls();

		const row = await collections.parkedCalls.findOne({});
		expect(row?.status).toBe("resumed");
		expect(seen.locals).toHaveLength(1);
		const servers = (seen.locals[0] as SeenLocals).mcp?.selectedServers ?? [];
		expect(servers.map((server) => server.name)).toEqual(["adhoc", "Joplin"]);
		expect(servers.find((server) => server.name === "Joplin")?.headers).toEqual({
			Authorization: "Bearer joplin-token",
		});
		// The ad-hoc server comes back as name and URL only — never a credential.
		expect(servers.find((server) => server.name === "adhoc")?.headers).toBeUndefined();
	});

	it("never resolves a connector for anybody but the user who parked", async () => {
		const stranger = new ObjectId();
		await seedParkedTurn({ connectorIds: [connectorId.toString()], customServers: [] });
		await collections.mcpConnectors.updateOne({ _id: connectorId }, { $set: { userId: stranger } });

		await sweepParkedCalls();

		const servers = (seen.locals[0] as SeenLocals).mcp?.selectedServers ?? [];
		expect(servers).toEqual([]);
	});

	it("resumes as before when the conversation recorded no selection", async () => {
		await seedParkedTurn();

		await sweepParkedCalls();

		expect(seen.locals).toHaveLength(1);
		expect((seen.locals[0] as SeenLocals).mcp).toBeUndefined();
	});
});
