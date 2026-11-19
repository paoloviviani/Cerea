import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { ready } from "$lib/server/database";
import { deleteConversationDeliverables } from "$lib/server/execution/deliverables";
import { MessageToolUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import { parseToolArguments } from "./toolArgs";
import { toPrimitive } from "./toolParams";
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

const SERVERS = [{ name: "github", url: "https://example.test/mcp" }];
const MAPPING = {
	download_bytes: { fnName: "download_bytes", server: "github", tool: "download-bytes" },
	create_or_update_file: {
		fnName: "create_or_update_file",
		server: "github",
		tool: "create_or_update_file",
	},
};

beforeAll(async () => {
	await ready;
});

let conversations: ObjectId[] = [];
afterEach(async () => {
	await deleteConversationDeliverables(conversations);
	conversations = [];
});
beforeEach(() => mcpMock.callMcpTool.mockReset());

async function run(conversationId: ObjectId, name: string, args: string) {
	const events = [];
	for await (const event of executeToolCalls({
		calls: [{ id: "call_1", name, arguments: args }],
		mapping: MAPPING,
		servers: SERVERS,
		parseArgs: parseToolArguments,
		toPrimitive,
		processToolOutput: (text: string) => ({ annotated: text, sources: [] }),
		elicitation: { conversationId, messageId: "msg-1" },
	})) {
		events.push(event);
	}
	return events;
}

/** Stores a file in the conversation the way a connector result does. */
async function storeFile(conversationId: ObjectId, bytes: Buffer, name: string) {
	mcpMock.callMcpTool.mockResolvedValueOnce({
		text: JSON.stringify({ name, value: bytes.toString("base64") }),
		isError: false,
	});
	await run(conversationId, "download_bytes", "{}");
}

describe("file references in a connector call, through executeToolCalls", () => {
	it("sends the file's content to the connector but keeps the reference on the card and the stored call", async () => {
		const conversationId = new ObjectId();
		conversations.push(conversationId);
		const xlsx = tinyXlsx();
		const b64 = xlsx.toString("base64");
		await storeFile(conversationId, xlsx, "book.xlsx");
		mcpMock.callMcpTool.mockResolvedValueOnce({ text: "committed", isError: false });

		const raw = JSON.stringify({
			path: "book.xlsx",
			content: { $file: "book.xlsx", encoding: "base64" },
		});
		const events = await run(conversationId, "create_or_update_file", raw);

		// The connector got the content.
		const [, , sent] = mcpMock.callMcpTool.mock.calls[1];
		expect(sent).toEqual({ path: "book.xlsx", content: b64 });

		// Nothing persisted or shown carries it: the stored arguments and the card keep the reference.
		const updates = events.flatMap((e) => (e.type === "update" ? [e.update] : []));
		expect(JSON.stringify(updates)).not.toContain(b64.slice(0, 60));
		const call = updates.find(
			(u) => u.type === MessageUpdateType.Tool && u.subtype === MessageToolUpdateType.Call
		);
		expect(call).toMatchObject({ argumentsRaw: raw });
		expect(JSON.stringify(call)).toContain("$file");
		const complete = events.find((e) => e.type === "complete");
		if (complete?.type !== "complete") throw new Error("no completion");
		expect(JSON.stringify(complete.summary.toolRuns)).not.toContain(b64.slice(0, 60));
	});

	it("does not call the connector for a file of another conversation", async () => {
		const mine = new ObjectId();
		const other = new ObjectId();
		conversations.push(mine, other);
		await storeFile(other, tinyXlsx(), "theirs.xlsx");
		mcpMock.callMcpTool.mockClear();

		const events = await run(
			mine,
			"create_or_update_file",
			JSON.stringify({ content: { $file: "theirs.xlsx", encoding: "base64" } })
		);

		expect(mcpMock.callMcpTool).not.toHaveBeenCalled();
		const updates = events.flatMap((e) => (e.type === "update" ? [e.update] : []));
		const error = updates.find(
			(u) => u.type === MessageUpdateType.Tool && u.subtype === MessageToolUpdateType.Error
		);
		expect(error).toMatchObject({ message: expect.stringContaining("No file named") });
	});
});
