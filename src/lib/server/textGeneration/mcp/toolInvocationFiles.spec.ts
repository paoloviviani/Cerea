import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { deleteConversationDeliverables } from "$lib/server/execution/deliverables";
import { MessageCodeExecutionUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import type { McpToolTextResponse } from "$lib/server/mcp/httpClient";
import { parseToolArguments } from "./toolArgs";
import { tinyXlsx } from "$lib/server/mcp/resultFilesFixtures";

const mcpMock = vi.hoisted(() => ({ callMcpTool: vi.fn() }));

vi.mock("$lib/server/mcp/httpClient", () => ({
	callMcpTool: mcpMock.callMcpTool,
	getMcpToolTimeoutMs: () => 1_000,
}));
vi.mock("$lib/server/mcp/clientPool", () => ({ getClient: vi.fn(async () => ({})) }));
vi.mock("../../logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { executeToolCalls } = await import("./toolInvocation");

const SERVERS = [{ name: "ms365", url: "https://example.test/mcp" }];
const MAPPING = {
	download_bytes: { fnName: "download_bytes", server: "ms365", tool: "download-bytes" },
};
const CALL = { id: "call_1", name: "download_bytes", arguments: '{"fileName":"ore_guardia.xlsx"}' };

beforeAll(async () => {
	await ready;
});

let conversations: ObjectId[] = [];
afterEach(async () => {
	await deleteConversationDeliverables(conversations);
	conversations = [];
});
beforeEach(() => mcpMock.callMcpTool.mockReset());

async function run(conversationId: ObjectId, response: Partial<McpToolTextResponse>) {
	mcpMock.callMcpTool.mockResolvedValue({ text: "", isError: false, ...response });
	const events = [];
	for await (const event of executeToolCalls({
		calls: [CALL],
		mapping: MAPPING,
		servers: SERVERS,
		parseArgs: parseToolArguments,
		toPrimitive: (v) =>
			typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined,
		processToolOutput: (text: string) => ({ annotated: text, sources: [] }),
		elicitation: { conversationId, messageId: "msg-1" },
	})) {
		events.push(event);
	}
	return events;
}

describe("a file a connector returns, through executeToolCalls", () => {
	it("stores it as a conversation file and keeps its base64 out of the model and the message", async () => {
		const conversationId = new ObjectId();
		conversations.push(conversationId);
		const xlsx = tinyXlsx();
		const b64 = xlsx.toString("base64");
		const text = JSON.stringify({ name: "ore_guardia.xlsx", size: xlsx.length, value: b64 });

		const events = await run(conversationId, {
			text,
			structured: { name: "ore_guardia.xlsx", value: b64 },
			content: [{ type: "text", text }],
		});

		// The deliverable row and its bytes.
		const rows = await collections.codeExecutionOutputs.find({ conversationId }).toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0].name).toBe("ore_guardia.xlsx");
		expect(rows[0].size).toBe(xlsx.length);
		expect(rows[0].messageIds).toEqual(["msg-1"]);
		expect(rows[0].tool).toBe("download_bytes");

		// What the model reads.
		const complete = events.find((e) => e.type === "complete");
		if (complete?.type !== "complete") throw new Error("no completion");
		const toolMessage = complete.summary.toolMessages.find((m) => m.role === "tool");
		const modelText = JSON.stringify(toolMessage);
		expect(modelText).toContain("file saved to this conversation: ore_guardia.xlsx");
		expect(modelText).toContain("/mnt/data/ore_guardia.xlsx");
		expect(modelText).toContain(String(xlsx.length));
		expect(modelText).not.toContain(b64.slice(0, 60));
		expect(JSON.stringify(complete.summary.toolRuns)).not.toContain(b64.slice(0, 60));

		// What is persisted on the message: every update, none with the bytes.
		const updates = events.flatMap((e) => (e.type === "update" ? [e.update] : []));
		expect(JSON.stringify(updates)).not.toContain(b64.slice(0, 60));
		const listing = updates.find(
			(u) =>
				u.type === MessageUpdateType.CodeExecution &&
				u.subtype === MessageCodeExecutionUpdateType.Outputs
		);
		expect(listing).toMatchObject({ files: [{ name: "ore_guardia.xlsx", size: xlsx.length }] });
	});

	it("a second, different file of the same name becomes the next version", async () => {
		const conversationId = new ObjectId();
		conversations.push(conversationId);
		const first = tinyXlsx();
		const second = Buffer.concat([
			first.subarray(0, first.length - 1),
			Buffer.from([first[first.length - 1] ^ 1]),
		]);
		for (const bytes of [first, second]) {
			await run(conversationId, {
				text: JSON.stringify({ name: "a.xlsx", value: bytes.toString("base64") }),
			});
		}
		const rows = await collections.codeExecutionOutputs
			.find({ conversationId })
			.sort({ version: 1 })
			.toArray();
		expect(rows.map((r) => [r.name, r.version])).toEqual([
			["a.xlsx", 1],
			["a.xlsx", 2],
		]);
	});

	it("leaves an ordinary result untouched", async () => {
		const conversationId = new ObjectId();
		conversations.push(conversationId);
		const events = await run(conversationId, { text: "plain answer" });
		expect(JSON.stringify(events)).toContain("plain answer");
		expect(await collections.codeExecutionOutputs.countDocuments({ conversationId })).toBe(0);
	});
});
