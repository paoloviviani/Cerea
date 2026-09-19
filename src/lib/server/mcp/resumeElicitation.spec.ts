import { describe, it, expect, beforeEach, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	isMessageElicitationRequestUpdate,
	isMessageElicitationResolvedUpdate,
} from "$lib/utils/messageUpdates";
import type { QueuedApprovalCall } from "$lib/types/McpElicitation";

/**
 * The tool call is stubbed rather than served over a socket: what is under test is which
 * branch a resume takes, and a real server would drag protocol negotiation, the shared
 * client pool and MCP_* config into a unit test.
 */
const calls = vi.hoisted(() => ({ queue: [] as unknown[], seen: [] as unknown[] }));
vi.mock("./httpClient", () => ({
	getMcpToolTimeoutMs: () => 1000,
	callMcpTool: async (
		_server: unknown,
		tool: string,
		args: unknown,
		opts: { resume?: unknown }
	) => {
		calls.seen.push({ tool, args, resume: opts?.resume });
		return calls.queue.shift() ?? { text: "", isError: false };
	},
}));

const fetchPageMock = vi.fn();
vi.mock("$lib/server/fetching", () => ({ fetchPage: fetchPageMock }));

const accessibilitySnapshotWithPlaywright = vi.fn();
vi.mock("$lib/server/fetching/playwright", () => ({ accessibilitySnapshotWithPlaywright }));

await ready;

const SERVERS = [{ name: "Mock", url: "http://mock.invalid/mcp" }];
const { resumeParkedToolCall } = await import("./resumeElicitation");

async function park(
	conversationId: ObjectId,
	inputKey: string,
	requestState: string | undefined,
	content: Record<string, string>
) {
	const elicitationId = crypto.randomUUID();
	await collections.mcpElicitations.insertOne({
		_id: new ObjectId(),
		elicitationId,
		conversationId,
		status: "resolved",
		action: "accept",
		content,
		request: { elicitationId, server: "Mock", mode: "form", message: "?", fields: [] },
		pending: {
			server: "Mock",
			tool: "confirm_twice",
			args: { a: 1 },
			inputKey,
			messageId: "m1",
			toolCallId: "c1",
			toolUuid: "u1",
			...(requestState !== undefined ? { requestState } : {}),
		},
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	return elicitationId;
}

const askAgain = (message: string, requestState: string) => ({
	text: "",
	isError: false,
	inputRequired: {
		requestState,
		inputRequests: {
			second: {
				method: "elicitation/create",
				params: {
					message,
					requestedSchema: { type: "object", properties: { sure: { type: "string" } } },
				},
			},
		},
	},
});

describe("resuming a parked tool call", () => {
	beforeEach(() => {
		calls.queue.length = 0;
		calls.seen.length = 0;
	});

	it("replays the answer and the opaque state to the same tool", async () => {
		calls.queue.push({ text: "done", isError: false });
		const conversationId = new ObjectId();
		const id = await park(conversationId, "first", "asked-once", { ok: "yes" });

		await resumeParkedToolCall({ conversationId, elicitationId: id, extraServers: SERVERS });

		expect(calls.seen).toEqual([
			{
				tool: "confirm_twice",
				args: { a: 1 },
				resume: {
					requestState: "asked-once",
					inputResponses: { first: { action: "accept", content: { ok: "yes" } } },
				},
			},
		]);
	});

	it("parks again when the tool asks a second time", async () => {
		// Returning here instead would hand the model a round that never produced a result.
		calls.queue.push(askAgain("Are you sure?", "asked-twice"));
		const conversationId = new ObjectId();
		const id = await park(conversationId, "first", "asked-once", { ok: "yes" });

		const round1 = await resumeParkedToolCall({
			conversationId,
			elicitationId: id,
			extraServers: SERVERS,
		});

		expect(round1.parkedAgain).toBe(true);
		// The answered prompt settles first, so a reloaded transcript stops showing it as an
		// open form and can render what was submitted.
		expect(round1.updates.find(isMessageElicitationResolvedUpdate)).toMatchObject({
			action: "accept",
			content: { ok: "yes" },
		});

		const prompt = round1.updates.find(isMessageElicitationRequestUpdate);
		expect(prompt?.request.message).toBe("Are you sure?");
		// A durable prompt carries no deadline, so the UI shows no countdown.
		expect(prompt?.expiresAt).toBeUndefined();

		const stored = await collections.mcpElicitations.findOne({
			elicitationId: prompt?.request.elicitationId,
		});
		expect(stored?.pending).toMatchObject({ requestState: "asked-twice", inputKey: "second" });
	});

	it("returns the tool result once the last question is answered", async () => {
		calls.queue.push({ text: "all done", isError: false });
		const conversationId = new ObjectId();
		const id = await park(conversationId, "second", "asked-twice", { sure: "yes" });

		const done = await resumeParkedToolCall({
			conversationId,
			elicitationId: id,
			extraServers: SERVERS,
		});

		expect(done.parkedAgain).toBeUndefined();
		expect(done.updates.find(isMessageElicitationResolvedUpdate)).toBeDefined();
		const result = done.updates.find((u) => u.type === "tool" && u.subtype === "result") as
			undefined | { result: { outputs: { text?: string }[] } };
		expect(result?.result.outputs[0]?.text).toBe("all done");
	});

	it("surfaces a failing tool call as an error on the same block", async () => {
		calls.queue.push({ text: "it broke", isError: true });
		const conversationId = new ObjectId();
		const id = await park(conversationId, "second", undefined, { sure: "yes" });

		const done = await resumeParkedToolCall({
			conversationId,
			elicitationId: id,
			extraServers: SERVERS,
		});

		expect(done.updates.find((u) => u.type === "tool" && u.subtype === "error")).toMatchObject({
			uuid: "u1",
			message: "it broke",
		});
	});

	it("will not resume another conversation's prompt", async () => {
		// The id alone is not authority: a page open on a different conversation must not
		// continue this one's tool call.
		calls.queue.push({ text: "should never run", isError: false });
		const owner = new ObjectId();
		const id = await park(owner, "first", "asked-once", { ok: "yes" });

		const outcome = await resumeParkedToolCall({
			conversationId: new ObjectId(),
			elicitationId: id,
			extraServers: SERVERS,
		});

		expect(outcome).toMatchObject({ resumed: false });
		expect(calls.seen).toHaveLength(0);
		// and the real owner can still resume it afterwards
		const mine = await resumeParkedToolCall({
			conversationId: owner,
			elicitationId: id,
			extraServers: SERVERS,
		});
		expect(mine.resumed).toBe(true);
		expect(calls.seen).toHaveLength(1);
	});

	it("reports a prompt it cannot resume rather than pretending", async () => {
		const outcome = await resumeParkedToolCall({
			conversationId: new ObjectId(),
			elicitationId: crypto.randomUUID(),
			extraServers: SERVERS,
		});

		expect(outcome).toMatchObject({ resumed: false });
		expect(outcome.updates).toHaveLength(0);
		expect(calls.seen).toHaveLength(0);
	});
});

describe("resuming the model's own question", () => {
	async function parkAsk(
		conversationId: ObjectId,
		action: "accept" | "decline",
		content?: Record<string, string | string[]>
	) {
		const elicitationId = crypto.randomUUID();
		await collections.mcpElicitations.insertOne({
			_id: new ObjectId(),
			elicitationId,
			conversationId,
			status: "resolved",
			action,
			...(content ? { content } : {}),
			request: {
				elicitationId,
				source: "assistant",
				server: "",
				mode: "form",
				message: "",
				fields: [
					{
						kind: "select",
						name: "q1",
						title: "Storage",
						description: "Where should uploads go?",
						required: true,
						multiple: false,
						options: [
							{ value: "S3", label: "S3" },
							{ value: "Disk", label: "Disk" },
						],
					},
				],
			},
			pending: { kind: "ask", messageId: "m1", toolCallId: "c1", toolUuid: "u1" },
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		return elicitationId;
	}

	beforeEach(() => {
		calls.queue.length = 0;
		calls.seen.length = 0;
	});

	it("hands the answer straight back without calling any server", async () => {
		const conversationId = new ObjectId();
		const id = await parkAsk(conversationId, "accept", { q1: "S3" });

		const outcome = await resumeParkedToolCall({
			conversationId,
			elicitationId: id,
			extraServers: SERVERS,
		});

		expect(calls.seen).toHaveLength(0);
		expect(outcome).toMatchObject({ resumed: true });
		expect(outcome.parkedAgain).toBeUndefined();

		const result = outcome.updates.find(
			(u) => "subtype" in u && u.subtype === "result"
		) as unknown as { result: { outputs: Array<{ text: string }> } };
		expect(result.result.outputs[0].text).toContain("Where should uploads go?");
		expect(result.result.outputs[0].text).toContain("S3");
	});

	it("settles the prompt so a reloaded transcript stops showing it open", async () => {
		const conversationId = new ObjectId();
		const id = await parkAsk(conversationId, "accept", { q1: "S3" });

		const outcome = await resumeParkedToolCall({
			conversationId,
			elicitationId: id,
			extraServers: SERVERS,
		});

		expect(outcome.updates.filter(isMessageElicitationResolvedUpdate)).toHaveLength(1);
	});

	it("tells the model to carry on when the question was skipped", async () => {
		const conversationId = new ObjectId();
		const id = await parkAsk(conversationId, "decline");

		const outcome = await resumeParkedToolCall({
			conversationId,
			elicitationId: id,
			extraServers: SERVERS,
		});

		const result = outcome.updates.find(
			(u) => "subtype" in u && u.subtype === "result"
		) as unknown as { result: { outputs: Array<{ text: string }> } };
		expect(result.result.outputs[0].text).toMatch(/best judgement/);
	});

	it("will not answer a question asked in another conversation", async () => {
		const id = await parkAsk(new ObjectId(), "accept", { q1: "S3" });

		const outcome = await resumeParkedToolCall({
			conversationId: new ObjectId(),
			elicitationId: id,
			extraServers: SERVERS,
		});

		expect(outcome).toMatchObject({ resumed: false });
		expect(outcome.updates).toHaveLength(0);
	});
});

describe("which turn a parked call belongs to", () => {
	it("comes from the record, not from whatever was sent since", async () => {
		const { parkedMessageId } = await import("./elicitation");
		const conversationId = new ObjectId();
		const elicitationId = crypto.randomUUID();
		await collections.mcpElicitations.insertOne({
			_id: new ObjectId(),
			elicitationId,
			conversationId,
			status: "pending",
			request: { elicitationId, server: "", mode: "form", message: "?", fields: [] },
			pending: { kind: "ask", messageId: "parked-message", toolCallId: "c1", toolUuid: "u1" },
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		expect(await parkedMessageId(conversationId, elicitationId)).toBe("parked-message");
		// Another conversation holding the id is not entitled to the answer.
		expect(await parkedMessageId(new ObjectId(), elicitationId)).toBeUndefined();
	});
});

describe("resuming a tool-approval prompt (ADR 0075)", () => {
	async function seedConversation(conversationId: ObjectId) {
		await collections.conversations.insertOne({
			_id: conversationId,
			sessionId: "s",
			model: "test-org/test-model",
			title: "a conversation",
			rootMessageId: "u1",
			messages: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
	}

	async function parkToolApproval(
		conversationId: ObjectId,
		action: "accept" | "decline",
		params: {
			tool: string;
			args: Record<string, unknown>;
			mcp?: { server: string; toolName: string };
			scope?: "once" | "conversation";
			queue?: QueuedApprovalCall[];
			toolUuid?: string;
		}
	) {
		const elicitationId = crypto.randomUUID();
		await collections.mcpElicitations.insertOne({
			_id: new ObjectId(),
			elicitationId,
			conversationId,
			status: "resolved",
			action,
			...(params.scope ? { content: { scope: params.scope } } : {}),
			request: {
				elicitationId,
				server: params.tool,
				mode: "form",
				message: `Call ${params.tool}?`,
				fields: [
					{
						kind: "select",
						name: "scope",
						title: "Allow this call?",
						required: true,
						multiple: false,
						options: [
							{ value: "once", label: "Allow this one call" },
							{ value: "conversation", label: "Allow this tool for the rest of the conversation" },
						],
					},
				],
				toolApproval: { tool: params.tool, args: params.args },
			},
			pending: {
				kind: "tool-approval",
				tool: params.tool,
				args: params.args,
				...(params.mcp ? { mcp: params.mcp } : {}),
				queue: params.queue ?? [],
				messageId: "m1",
				toolCallId: "c1",
				toolUuid: params.toolUuid ?? "u1",
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		return elicitationId;
	}

	beforeEach(() => {
		fetchPageMock.mockReset();
		accessibilitySnapshotWithPlaywright.mockReset();
		calls.queue.length = 0;
		calls.seen.length = 0;
	});

	it("performs the web_fetch call itself once approved, without granting the tool for the conversation", async () => {
		const conversationId = new ObjectId();
		await seedConversation(conversationId);
		const url = "https://unseen.test/page";
		fetchPageMock.mockResolvedValueOnce({
			url,
			title: "Unseen",
			content: "<p>hello</p>",
			contentType: "text/html",
			backend: "playwright",
		});
		const id = await parkToolApproval(conversationId, "accept", {
			tool: "web_fetch",
			args: { url },
			scope: "once",
		});

		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: id });

		expect(outcome.resumed).toBe(true);
		const result = outcome.updates.find((u) => "subtype" in u && u.subtype === "result") as
			undefined | { result: { call: { name: string }; outputs: { text?: string }[] } };
		expect(result?.result.call.name).toBe("web_fetch");
		expect(result?.result.outputs[0]?.text).toContain("hello");

		const conv = await collections.conversations.findOne({ _id: conversationId });
		expect(conv?.approvedTools ?? []).toEqual([]);
	});

	it("grants the tool for the rest of the conversation and reports it to the caller", async () => {
		const conversationId = new ObjectId();
		await seedConversation(conversationId);
		const url = "https://known-later.test/page";
		fetchPageMock.mockResolvedValueOnce({
			url,
			title: "Known later",
			content: "<p>hi again</p>",
			contentType: "text/html",
			backend: "playwright",
		});
		const id = await parkToolApproval(conversationId, "accept", {
			tool: "web_fetch",
			args: { url },
			scope: "conversation",
		});

		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: id });

		expect(outcome.grantedTools).toEqual(["web_fetch"]);
		const conv = await collections.conversations.findOne({ _id: conversationId });
		expect(conv?.approvedTools).toEqual(["web_fetch"]);
	});

	it("runs nothing and grants nothing when the user declines, feeding the refusal back to the model", async () => {
		const conversationId = new ObjectId();
		await seedConversation(conversationId);
		const url = "https://unseen.test/declined";
		const id = await parkToolApproval(conversationId, "decline", {
			tool: "web_fetch",
			args: { url },
		});

		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: id });

		expect(fetchPageMock).not.toHaveBeenCalled();
		expect(outcome.updates.find((u) => "subtype" in u && u.subtype === "error")).toMatchObject({
			message: expect.stringContaining("declined"),
		});
		const conv = await collections.conversations.findOne({ _id: conversationId });
		expect(conv?.approvedTools ?? []).toEqual([]);
	});

	it("re-issues an approved MCP call directly, not through inputResponses", async () => {
		calls.queue.push({ text: "search results", isError: false });
		const conversationId = new ObjectId();
		await seedConversation(conversationId);
		const id = await parkToolApproval(conversationId, "accept", {
			tool: "Mock:search",
			args: { q: "cats" },
			mcp: { server: "Mock", toolName: "search" },
			scope: "once",
		});

		const outcome = await resumeParkedToolCall({
			conversationId,
			elicitationId: id,
			extraServers: SERVERS,
		});

		expect(calls.seen).toEqual([{ tool: "search", args: { q: "cats" }, resume: undefined }]);
		const result = outcome.updates.find((u) => "subtype" in u && u.subtype === "result") as
			undefined | { result: { outputs: { text?: string }[] } };
		expect(result?.result.outputs[0]?.text).toBe("search results");
	});

	it("drains a queued call behind the resolved one when it shares the just-granted tool", async () => {
		const conversationId = new ObjectId();
		await seedConversation(conversationId);
		fetchPageMock
			.mockResolvedValueOnce({
				url: "https://a.test/1",
				title: "A",
				content: "<p>first page</p>",
				contentType: "text/html",
				backend: "playwright",
			})
			.mockResolvedValueOnce({
				url: "https://a.test/2",
				title: "B",
				content: "<p>second page</p>",
				contentType: "text/html",
				backend: "playwright",
			});
		const id = await parkToolApproval(conversationId, "accept", {
			tool: "web_fetch",
			args: { url: "https://a.test/1" },
			scope: "conversation",
			toolUuid: "u1",
			queue: [
				{
					toolUuid: "u2",
					toolCallId: "c2",
					tool: "web_fetch",
					args: { url: "https://a.test/2" },
				},
			],
		});

		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: id });

		// Both calls ran: the queued one was auto-cleared by the conversation-scope
		// grant the first click just made, with no second prompt in between.
		expect(outcome.parkedAgain).toBeUndefined();
		const results = outcome.updates.filter((u) => "subtype" in u && u.subtype === "result") as {
			uuid: string;
			result: { outputs: { text?: string }[] };
		}[];
		expect(results.map((r) => r.uuid)).toEqual(["u1", "u2"]);
		expect(results[1].result.outputs[0]?.text).toContain("second page");
		expect(outcome.updates.some((u) => "subtype" in u && u.subtype === "request")).toBe(false);
	});

	it("opens a fresh prompt for a queued call needing its own approval, and parks again", async () => {
		const conversationId = new ObjectId();
		await seedConversation(conversationId);
		fetchPageMock.mockResolvedValueOnce({
			url: "https://a.test/1",
			title: "A",
			content: "<p>first page</p>",
			contentType: "text/html",
			backend: "playwright",
		});
		const id = await parkToolApproval(conversationId, "accept", {
			tool: "web_fetch",
			args: { url: "https://a.test/1" },
			scope: "once",
			toolUuid: "u1",
			queue: [
				{
					toolUuid: "u2",
					toolCallId: "c2",
					tool: "Mock:search",
					args: { q: "dogs" },
					mcp: { server: "Mock", toolName: "search" },
				},
			],
		});

		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: id });

		expect(outcome.parkedAgain).toBe(true);
		expect(calls.seen).toHaveLength(0);
		const prompt = outcome.updates.find(isMessageElicitationRequestUpdate);
		expect(prompt?.toolUuid).toBe("u2");
		expect(prompt?.request.toolApproval).toMatchObject({ tool: "Mock:search" });

		const stored = await collections.mcpElicitations.findOne({
			elicitationId: prompt?.request.elicitationId,
		});
		expect(stored?.pending).toMatchObject({
			kind: "tool-approval",
			tool: "Mock:search",
			queue: [],
		});
	});

	// ADR 0079: `runApprovedCall`'s non-MCP branch used to assume `web_fetch`
	// unconditionally for any call with no `mcp` field. Written first against
	// the unfixed dispatch and confirmed it failed for the right reason
	// (`fetchPageMock` was called with the structured call's args, and the
	// result named the call "web_fetch") before the name-keyed table made it
	// pass. This regression stands regardless of which second gated builtin
	// exposed it — the bug was in the dispatch, not in any one tool.
	it("re-issues an approved web_fetch_structured call through its own renderer, not web_fetch", async () => {
		const conversationId = new ObjectId();
		await seedConversation(conversationId);
		const url = "https://unseen.test/structured";
		accessibilitySnapshotWithPlaywright.mockResolvedValue({
			url,
			title: "A page",
			snapshot: "- generic [ref=e1]: hello",
		});
		const id = await parkToolApproval(conversationId, "accept", {
			tool: "web_fetch_structured",
			args: { url },
			scope: "once",
		});

		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: id });

		expect(fetchPageMock).not.toHaveBeenCalled();
		expect(accessibilitySnapshotWithPlaywright).toHaveBeenCalledWith(url);
		const result = outcome.updates.find((u) => "subtype" in u && u.subtype === "result") as
			undefined | { result: { call: { name: string }; outputs: { text?: string }[] } };
		expect(result?.result.call.name).toBe("web_fetch_structured");
		expect(result?.result.outputs[0]?.text).toContain("ref=e1");
	});

	it("denies an approval-queue tool name nothing recognizes, rather than mis-dispatching it", async () => {
		const conversationId = new ObjectId();
		await seedConversation(conversationId);
		const id = await parkToolApproval(conversationId, "accept", {
			tool: "not_a_real_tool",
			args: { url: "https://unseen.test/x" },
			scope: "once",
		});

		const outcome = await resumeParkedToolCall({ conversationId, elicitationId: id });

		expect(fetchPageMock).not.toHaveBeenCalled();
		const error = outcome.updates.find((u) => "subtype" in u && u.subtype === "error") as
			undefined | { message: string };
		expect(error?.message).toContain("Unknown tool");
	});
});
