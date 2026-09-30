import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ToolApprovalCard from "./ToolApprovalCard.svelte";
import type { ElicitationRequestPayload } from "$lib/types/McpElicitation";

vi.mock("$lib/utils/sendElicitationAnswer", () => ({
	sendElicitationAnswer: async () => ({ ok: true }),
}));

const LONG_PROMPT = `Review the migration plan.\n${"Check every table. ".repeat(80)}END-OF-PROMPT`;

function request(tool: string, args: Record<string, unknown>): ElicitationRequestPayload {
	return {
		elicitationId: "gp_1",
		server: tool,
		mode: "form",
		message: "irrelevant",
		toolApproval: { tool, args },
	} as ElicitationRequestPayload;
}

const spawn = request("session_spawn", {
	galopin: true,
	title: "Migration review",
	modeId: "plan",
	modelId: null,
	workspaceId: "w1",
	prompt: LONG_PROMPT,
});

const send = request("session_send", {
	galopin: true,
	target: { sessionId: "s2", title: "Docs agent", workspaceId: "w1" },
	text: "Please update the changelog.",
	hop: 1,
});

describe("ToolApprovalCard, galopin approvals", () => {
	it("shows a spawn's title, mode and the whole prompt, and offers no Always allow", async () => {
		const screen = render(ToolApprovalCard, {
			conversationId: "a1",
			request: spawn,
			onanswer: async () => ({ ok: true }),
		});
		const facts = screen.getByTestId("galopin-approval");
		await expect.element(facts).toHaveTextContent("Migration review");
		await expect.element(facts).toHaveTextContent("plan");
		await expect.element(facts).toHaveTextContent("this session's model");
		// The end of the prompt is there: nothing is truncated for display.
		await expect.element(facts).toHaveTextContent("END-OF-PROMPT");
		await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Deny" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Always allow" }).elements()).toHaveLength(0);
	});

	it("shows who a send goes to and exactly what it says", async () => {
		const screen = render(ToolApprovalCard, {
			conversationId: "a1",
			request: send,
			onanswer: async () => ({ ok: true }),
		});
		const facts = screen.getByTestId("galopin-approval");
		await expect.element(facts).toHaveTextContent("Docs agent");
		await expect.element(facts).toHaveTextContent("Please update the changelog.");
		await expect.element(facts).toHaveTextContent("1 of 3");
	});

	it("says why a fourth hop asks, rather than 4 of 3", async () => {
		const screen = render(ToolApprovalCard, {
			conversationId: "a1",
			request: request("session_send", {
				galopin: true,
				target: { sessionId: "s2", title: "Docs agent", workspaceId: "w1" },
				text: "Please update the changelog.",
				hop: 4,
			}),
			onanswer: async () => ({ ok: true }),
		});
		const facts = screen.getByTestId("galopin-approval");
		await expect
			.element(facts)
			.toHaveTextContent("This chain has passed 3 hops, so each further message needs you");
	});

	it("answers Allow once as an accept without a scope", async () => {
		const onanswer = vi.fn(async () => ({ ok: true }));
		const screen = render(ToolApprovalCard, { conversationId: "a1", request: send, onanswer });
		await screen.getByRole("button", { name: "Allow once" }).click();
		expect(onanswer).toHaveBeenCalledWith("accept", undefined);
	});

	it("an ordinary agent permission keeps Always allow", async () => {
		const screen = render(ToolApprovalCard, {
			conversationId: "a1",
			request: request("bash", { command: "ls" }),
			onanswer: async () => ({ ok: true }),
		});
		await expect.element(screen.getByRole("button", { name: "Always allow" })).toBeVisible();
	});

	it("does not trust a galopin flag in chat, where the arguments are a model's own", async () => {
		const screen = render(ToolApprovalCard, { conversationId: "c1", request: spawn });
		expect(screen.getByTestId("galopin-approval").elements()).toHaveLength(0);
		await expect
			.element(screen.getByRole("button", { name: "Allow for this conversation" }))
			.toBeVisible();
	});
});
