import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const fake = vi.hoisted(() => ({
	callMcpTool: vi.fn(),
	updateOne: vi.fn(async () => ({})),
	resolve: vi.fn(),
	toolMeta: vi.fn(),
	issue: vi.fn(),
	consume: vi.fn(),
}));

vi.mock("../httpClient", () => ({
	callMcpTool: fake.callMcpTool,
	getMcpToolTimeoutMs: () => 1000,
}));
vi.mock("$lib/server/database", () => ({
	collections: { conversations: { updateOne: fake.updateOne } },
}));
vi.mock("./pageApprovals", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./pageApprovals")>();
	return { ...actual, issueApproval: fake.issue, consumeApproval: fake.consume };
});
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
	({ _id: new ObjectId(), approvedAppTools: [], ...over }) as never;
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
	fake.issue.mockReset();
	fake.issue.mockResolvedValue({ ok: true, id: "11111111-1111-4111-8111-111111111111" });
	fake.consume.mockReset();
	fake.consume.mockResolvedValue(true);
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
	const ID = "11111111-1111-4111-8111-111111111111";
	const once = { id: ID, choice: "once" as const };

	it("is refused for approval under Ask, with an id for the click, and nothing is called", async () => {
		const outcome = await callToolFromPage(base());

		expect(outcome).toMatchObject({
			ok: false,
			status: 409,
			code: "approval_required",
			approval: { id: ID, tool: "Maps:refresh", server: "Maps", toolName: "refresh" },
		});
		expect(fake.callMcpTool).not.toHaveBeenCalled();
	});

	it("binds the approval to the call: user, connector, tool and the exact arguments", async () => {
		const userId = new ObjectId();
		await callToolFromPage(base({ userId }));
		await callToolFromPage(base({ userId, args: { id: 2 } }));
		await callToolFromPage(base({ userId: new ObjectId() }));

		const hashes = fake.issue.mock.calls.map((c) => c[1]);
		expect(new Set(hashes).size).toBe(3);
		// Key order does not change what the call is.
		await callToolFromPage(base({ userId, args: { b: 1, a: 2 } }));
		await callToolFromPage(base({ userId, args: { a: 2, b: 1 } }));
		const [x, y] = fake.issue.mock.calls.slice(-2).map((c) => c[1]);
		expect(x).toBe(y);
	});

	it("refuses a second page call while an approval is already waiting", async () => {
		fake.issue.mockResolvedValue({ ok: false });

		expect(await callToolFromPage(base())).toMatchObject({
			ok: false,
			status: 429,
			code: "approval_busy",
		});
	});

	it("rate limits asking too, not only calling", async () => {
		const conv = conversation();
		const userId = new ObjectId();
		for (let i = 0; i < PAGE_CALLS_BURST; i += 1) {
			await callToolFromPage(base({ conversation: conv, userId }));
		}

		expect(await callToolFromPage(base({ conversation: conv, userId }))).toMatchObject({
			ok: false,
			status: 429,
			code: "rate_limited",
		});
	});

	it("runs once the user's click spent the approval issued for this call, without a grant", async () => {
		const outcome = await callToolFromPage(base({ approval: once }));

		expect(outcome.ok).toBe(true);
		expect(fake.consume).toHaveBeenCalledWith(expect.anything(), ID, expect.any(String));
		expect(fake.callMcpTool).toHaveBeenCalledTimes(1);
		expect(fake.updateOne).not.toHaveBeenCalled();
	});

	it("never trusts the word alone: an id that was not issued for this call, or was spent, runs nothing", async () => {
		fake.consume.mockResolvedValue(false);

		expect(await callToolFromPage(base({ approval: once }))).toMatchObject({
			ok: false,
			status: 403,
			code: "approval_invalid",
		});
		expect(fake.callMcpTool).not.toHaveBeenCalled();
	});

	it("a denial frees the slot and runs nothing", async () => {
		const outcome = await callToolFromPage(base({ approval: { id: ID, choice: "deny" } }));

		expect(outcome).toMatchObject({ ok: false, code: "denied" });
		expect(fake.consume).toHaveBeenCalled();
		expect(fake.callMcpTool).not.toHaveBeenCalled();
	});

	it("records the page's own grant when approved for the conversation, never the model's", async () => {
		const conv = conversation();
		await callToolFromPage(
			base({ conversation: conv, approval: { id: ID, choice: "conversation" } })
		);

		expect(fake.updateOne).toHaveBeenCalledWith(
			{ _id: (conv as { _id: ObjectId })._id },
			{ $addToSet: { approvedAppTools: "connector:1:refresh" } }
		);
		expect(fake.callMcpTool).toHaveBeenCalledTimes(1);
	});

	it("is not covered by a grant the model's call holds: the lists are separate", async () => {
		const outcome = await callToolFromPage(
			base({ conversation: conversation({ approvedTools: ["Maps:refresh"] }) })
		);

		expect(outcome).toMatchObject({ ok: false, code: "approval_required" });
		expect(fake.callMcpTool).not.toHaveBeenCalled();
	});

	it("keys a grant by the connector, so a grant for a user's connector 'Maps' never covers a deployment connector 'Maps'", async () => {
		// The grant was given to another connector that has the same name.
		const outcome = await callToolFromPage(
			base({
				conversation: conversation({ approvedAppTools: ["connector:other:refresh"] }),
				connector: "connector:1",
			})
		);

		expect(outcome).toMatchObject({ ok: false, code: "approval_required" });
		expect(fake.callMcpTool).not.toHaveBeenCalled();
	});

	it("runs without asking when the conversation already holds the grant", async () => {
		const outcome = await callToolFromPage(
			base({ conversation: conversation({ approvedAppTools: ["connector:1:refresh"] }) })
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
		await callToolFromPage(base({ userId, approval: once }));

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
		expect(await callToolFromPage(base({ approval: once }))).toMatchObject({
			ok: false,
			code: "unknown_tool",
		});

		fake.toolMeta.mockResolvedValue({ listed: true, ui: { visibility: ["model"] } });
		expect(await callToolFromPage(base({ approval: once }))).toMatchObject({
			ok: false,
			code: "unknown_tool",
		});
		expect(fake.callMcpTool).not.toHaveBeenCalled();
	});

	it("allows an app-only tool", async () => {
		fake.toolMeta.mockResolvedValue({ listed: true, ui: { visibility: ["app"] } });
		expect((await callToolFromPage(base({ approval: once }))).ok).toBe(true);
	});

	it("refuses when the connector is gone or apps are blocked for it", async () => {
		fake.resolve.mockRejectedValue(new McpAppError("not-allowed", "blocked"));
		expect(await callToolFromPage(base({ approval: once }))).toMatchObject({
			ok: false,
			status: 403,
			code: "not_allowed",
		});

		fake.resolve.mockRejectedValue(new McpAppError("unknown-connector", "gone"));
		expect(await callToolFromPage(base({ approval: once }))).toMatchObject({
			ok: false,
			status: 404,
			code: "unknown_connector",
		});
		expect(fake.callMcpTool).not.toHaveBeenCalled();
	});

	it("is rate limited, and the limit is the server's", async () => {
		const conv = conversation();
		const input = base({ conversation: conv, approval: once });
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

		const outcome = await callToolFromPage(base({ approval: once }));

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
		expect(await callToolFromPage(base({ approval: once }))).toMatchObject({
			ok: false,
			code: "needs_input",
		});
	});

	it("turns a transport failure into an error the page sees", async () => {
		fake.callMcpTool.mockRejectedValue(new Error("connection closed"));
		expect(await callToolFromPage(base({ approval: once }))).toMatchObject({
			ok: false,
			status: 502,
			code: "failed",
		});
	});
});
