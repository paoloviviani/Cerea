import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const fake = vi.hoisted(() => ({
	callMcpTool: vi.fn(),
	updateOne: vi.fn(async () => ({})),
	resolve: vi.fn(),
	toolMeta: vi.fn(),
}));

vi.mock("../httpClient", () => ({
	callMcpTool: fake.callMcpTool,
	getMcpToolTimeoutMs: () => 1000,
}));
vi.mock("$lib/server/database", () => ({
	collections: { conversations: { updateOne: fake.updateOne } },
}));
vi.mock("../tools", () => ({ getToolUiMeta: fake.toolMeta }));
vi.mock("./resource", async () => {
	class McpAppError extends Error {
		constructor(
			readonly code: string,
			message: string
		) {
			super(message);
		}
	}
	return { McpAppError, resolveAppServer: fake.resolve };
});
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { callToolFromPage } = await import("./pageCall");
const { resetPageCallLimit, PAGE_CALLS_BURST } = await import("./pageCallLimit");
const { McpAppError } = await import("./resource");

const conversation = (over: Record<string, unknown> = {}) =>
	({ _id: new ObjectId(), approvedTools: [], ...over }) as never;
const base = (over: Record<string, unknown> = {}) => ({
	conversation: conversation(),
	settings: { toolApprovalPolicy: "manual" as const },
	userId: new ObjectId(),
	connector: "connector:1",
	tool: "refresh",
	args: { id: 1 },
	...over,
});

beforeEach(() => {
	resetPageCallLimit();
	fake.callMcpTool.mockReset();
	fake.callMcpTool.mockResolvedValue({
		text: "ok",
		isError: false,
		content: [{ type: "text", text: "ok" }],
	});
	fake.updateOne.mockClear();
	fake.resolve.mockReset();
	fake.resolve.mockResolvedValue({
		key: "connector:1",
		name: "Maps",
		url: "https://maps.example/mcp",
	});
	fake.toolMeta.mockReset();
	fake.toolMeta.mockResolvedValue({ listed: true, ui: undefined });
});

describe("a tool call started by a page", () => {
	it("is refused for approval under Ask, and nothing is called", async () => {
		const outcome = await callToolFromPage(base());

		expect(outcome).toMatchObject({
			ok: false,
			status: 409,
			code: "approval_required",
			approval: { tool: "Maps:refresh", server: "Maps", toolName: "refresh" },
		});
		expect(fake.callMcpTool).not.toHaveBeenCalled();
	});

	it("runs once the user has approved it once, without recording a grant", async () => {
		const outcome = await callToolFromPage(base({ approval: "once" }));

		expect(outcome.ok).toBe(true);
		expect(fake.callMcpTool).toHaveBeenCalledTimes(1);
		expect(fake.updateOne).not.toHaveBeenCalled();
	});

	it("records the same grant a model's call would when approved for the conversation", async () => {
		const conv = conversation();
		await callToolFromPage(base({ conversation: conv, approval: "conversation" }));

		expect(fake.updateOne).toHaveBeenCalledWith(
			{ _id: (conv as { _id: ObjectId })._id },
			{ $addToSet: { approvedTools: "Maps:refresh" } }
		);
		expect(fake.callMcpTool).toHaveBeenCalledTimes(1);
	});

	it("runs without asking when the conversation already holds the grant", async () => {
		const outcome = await callToolFromPage(
			base({ conversation: conversation({ approvedTools: ["Maps:refresh"] }) })
		);

		expect(outcome.ok).toBe(true);
	});

	it("runs without asking under Allow", async () => {
		const outcome = await callToolFromPage(
			base({ settings: { toolApprovalPolicy: "always-allow" } })
		);

		expect(outcome.ok).toBe(true);
	});

	it("respects a conversation's own override of the policy", async () => {
		const outcome = await callToolFromPage(
			base({
				settings: { toolApprovalPolicy: "always-allow" },
				conversation: conversation({ toolApprovalOverride: "manual" }),
			})
		);

		expect(outcome).toMatchObject({ ok: false, code: "approval_required" });
	});

	it("calls the connector's tool with the connector's own server, resolved for this user", async () => {
		const userId = new ObjectId();
		await callToolFromPage(base({ userId, approval: "once" }));

		expect(fake.resolve).toHaveBeenCalledWith("connector:1", userId);
		expect(fake.callMcpTool).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Maps", url: "https://maps.example/mcp" }),
			"refresh",
			{ id: 1 },
			expect.anything()
		);
	});

	it("refuses a tool that is not listed on that connector, or is not visible to apps", async () => {
		fake.toolMeta.mockResolvedValue({ listed: false });
		expect(await callToolFromPage(base({ approval: "once" }))).toMatchObject({
			ok: false,
			code: "unknown_tool",
		});

		fake.toolMeta.mockResolvedValue({ listed: true, ui: { visibility: ["model"] } });
		expect(await callToolFromPage(base({ approval: "once" }))).toMatchObject({
			ok: false,
			code: "unknown_tool",
		});
		expect(fake.callMcpTool).not.toHaveBeenCalled();
	});

	it("allows an app-only tool", async () => {
		fake.toolMeta.mockResolvedValue({ listed: true, ui: { visibility: ["app"] } });
		expect((await callToolFromPage(base({ approval: "once" }))).ok).toBe(true);
	});

	it("refuses when the connector is gone or apps are blocked for it", async () => {
		fake.resolve.mockRejectedValue(new McpAppError("not-allowed", "blocked"));
		expect(await callToolFromPage(base({ approval: "once" }))).toMatchObject({
			ok: false,
			status: 403,
			code: "not_allowed",
		});

		fake.resolve.mockRejectedValue(new McpAppError("unknown-connector", "gone"));
		expect(await callToolFromPage(base({ approval: "once" }))).toMatchObject({
			ok: false,
			status: 404,
			code: "unknown_connector",
		});
		expect(fake.callMcpTool).not.toHaveBeenCalled();
	});

	it("is rate limited, and the limit is the server's", async () => {
		const conv = conversation();
		const input = base({ conversation: conv, approval: "once" });
		for (let i = 0; i < PAGE_CALLS_BURST; i += 1) {
			expect((await callToolFromPage(input)).ok).toBe(true);
		}
		const outcome = await callToolFromPage(input);

		expect(outcome).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
		expect(fake.callMcpTool).toHaveBeenCalledTimes(PAGE_CALLS_BURST);
	});

	it("does not count a call that was only refused for approval", async () => {
		const conv = conversation();
		for (let i = 0; i < PAGE_CALLS_BURST + 3; i += 1) {
			expect(await callToolFromPage(base({ conversation: conv }))).toMatchObject({
				code: "approval_required",
			});
		}
	});

	it("returns the tool's content, structured content and error flag as an MCP result", async () => {
		fake.callMcpTool.mockResolvedValue({
			text: "x",
			isError: true,
			structured: { rows: 2 },
			content: [{ type: "text", text: "bad" }],
		});

		const outcome = await callToolFromPage(base({ approval: "once" }));

		expect(outcome).toEqual({
			ok: true,
			result: {
				content: [{ type: "text", text: "bad" }],
				structuredContent: { rows: 2 },
				isError: true,
			},
		});
	});

	it("does not wait for interactive input: there is no turn to park", async () => {
		fake.callMcpTool.mockResolvedValue({
			text: "",
			isError: false,
			inputRequired: { inputRequests: {} },
		});
		expect(await callToolFromPage(base({ approval: "once" }))).toMatchObject({
			ok: false,
			code: "needs_input",
		});
	});

	it("turns a transport failure into an error the page sees", async () => {
		fake.callMcpTool.mockRejectedValue(new Error("connection closed"));
		expect(await callToolFromPage(base({ approval: "once" }))).toMatchObject({
			ok: false,
			status: 502,
			code: "failed",
		});
	});
});
