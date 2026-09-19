import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { BuiltinToolContext } from "./types";

const accessibilitySnapshotWithPlaywright = vi.fn();
vi.mock("$lib/server/fetching/playwright", () => ({ accessibilitySnapshotWithPlaywright }));

const {
	createWebFetchStructuredBuiltin,
	performAccessibilitySnapshot,
	WEB_FETCH_STRUCTURED_TOOL_NAME,
	MAX_STRUCTURED_SNAPSHOT_CALLS_PER_TURN,
} = await import("./webFetchStructuredTool");
const { MAX_FETCH_RESULT_CHARS } = await import("./webFetchTool");

function fakeContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
	return {
		uuid: "call-uuid",
		toolCallId: "call-1",
		conversationId: new ObjectId(),
		messageId: "message-1",
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe("web_fetch_structured builtin", () => {
	it("is offered as a separate, explicit tool", () => {
		const tool = createWebFetchStructuredBuiltin({ toolApprovalPolicy: "always-allow" });
		expect(tool.name).toBe(WEB_FETCH_STRUCTURED_TOOL_NAME);
		expect(tool.definition.function.parameters?.required).toEqual(["url"]);
	});

	it("refuses a call that reached execute() without clearing the approval gate", async () => {
		const tool = createWebFetchStructuredBuiltin({});
		const result = await tool.execute({ url: "https://example.test/" }, fakeContext());
		expect(result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("not approved") })
		);
		expect(accessibilitySnapshotWithPlaywright).not.toHaveBeenCalled();
	});

	it("runs straight through under always-allow", async () => {
		accessibilitySnapshotWithPlaywright.mockResolvedValue({
			url: "https://example.test/",
			title: "A page",
			snapshot: "- generic [ref=e1]: hello",
		});
		const tool = createWebFetchStructuredBuiltin({ toolApprovalPolicy: "always-allow" });
		const result = await tool.execute({ url: "https://example.test/" }, fakeContext());
		expect(result).toEqual(
			expect.objectContaining({ resultText: expect.stringContaining("[ref=e1]: hello") })
		);
	});

	it("runs once the conversation has granted exactly this tool name", async () => {
		accessibilitySnapshotWithPlaywright.mockResolvedValue({
			url: "https://example.test/",
			title: null,
			snapshot: "- generic [ref=e2]: hi",
		});
		const tool = createWebFetchStructuredBuiltin({
			approvedTools: new Set([WEB_FETCH_STRUCTURED_TOOL_NAME]),
		});
		const result = await tool.execute({ url: "https://example.test/" }, fakeContext());
		expect("error" in result).toBe(false);
	});

	// The grant that clears web_fetch_structured must not also clear an
	// unrelated tool name — ADR 0075's per-tool-name granularity.
	it("does not run on a grant for a different tool name", async () => {
		const tool = createWebFetchStructuredBuiltin({ approvedTools: new Set(["web_fetch"]) });
		const result = await tool.execute({ url: "https://example.test/" }, fakeContext());
		expect(result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("not approved") })
		);
		expect(accessibilitySnapshotWithPlaywright).not.toHaveBeenCalled();
	});

	it("rejects a URL that is not valid HTTPS before ever calling the renderer", async () => {
		const tool = createWebFetchStructuredBuiltin({ toolApprovalPolicy: "always-allow" });
		const result = await tool.execute({ url: "not a url" }, fakeContext());
		expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining("HTTPS") }));
		expect(accessibilitySnapshotWithPlaywright).not.toHaveBeenCalled();
	});

	it("errors rather than returning an empty snapshot", async () => {
		accessibilitySnapshotWithPlaywright.mockResolvedValue({
			url: "https://example.test/",
			title: null,
			snapshot: "   ",
		});
		const { result } = await performAccessibilitySnapshot("https://example.test/");
		expect(result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("no accessible") })
		);
	});

	it("truncates a snapshot longer than the shared fetch result cap", async () => {
		accessibilitySnapshotWithPlaywright.mockResolvedValue({
			url: "https://example.test/",
			title: null,
			snapshot: "e".repeat(MAX_FETCH_RESULT_CHARS + 500),
		});
		const { result } = await performAccessibilitySnapshot("https://example.test/");
		expect("resultText" in result && result.resultText).toEqual(
			expect.stringContaining("[Content truncated.]")
		);
	});

	it("refuses once the per-turn call limit is reached", async () => {
		accessibilitySnapshotWithPlaywright.mockResolvedValue({
			url: "https://example.test/",
			title: null,
			snapshot: "- generic [ref=e1]: hello",
		});
		const tool = createWebFetchStructuredBuiltin({ toolApprovalPolicy: "always-allow" });
		for (let i = 0; i < MAX_STRUCTURED_SNAPSHOT_CALLS_PER_TURN; i += 1) {
			const result = await tool.execute({ url: "https://example.test/" }, fakeContext());
			expect("error" in result).toBe(false);
		}
		const overLimit = await tool.execute({ url: "https://example.test/" }, fakeContext());
		expect(overLimit).toEqual(expect.objectContaining({ error: expect.stringContaining("limit") }));
	});

	it("surfaces a renderer failure as a tool error rather than throwing", async () => {
		accessibilitySnapshotWithPlaywright.mockRejectedValue(
			new Error("Could not reach the page renderer.")
		);
		const tool = createWebFetchStructuredBuiltin({ toolApprovalPolicy: "always-allow" });
		const result = await tool.execute({ url: "https://example.test/" }, fakeContext());
		expect(result).toEqual(
			expect.objectContaining({ error: expect.stringContaining("Could not read that page") })
		);
	});
});
