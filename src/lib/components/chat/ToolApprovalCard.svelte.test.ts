import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ToolApprovalCard from "./ToolApprovalCard.svelte";
import type { ElicitationRequestPayload } from "$lib/types/McpElicitation";
import { ALWAYS_CAPPED, type AlwaysCapped } from "$lib/utils/alwaysCappedContext";
import { FIRST_TURN_SUBAGENT, type FirstTurnSubagent } from "$lib/utils/firstTurnSubagent";

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
		expect(
			screen.getByRole("button", { name: "Always allow (this session)" }).elements()
		).toHaveLength(0);
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
		await expect
			.element(screen.getByRole("button", { name: "Always allow (this session)" }))
			.toBeVisible();
	});

	it("labels the agent's second button as a per-session exception, never a standing grant", async () => {
		const screen = render(ToolApprovalCard, {
			conversationId: "a1",
			request: request("bash", { command: "ls" }),
			onanswer: async () => ({ ok: true }),
		});
		const text = screen.container.textContent ?? "";
		expect(text).toContain("Always allow (this session)");
		expect(text).not.toMatch(/Always allow(?! \(this session\))/);
	});

	it("answers Always allow with the always scope", async () => {
		const onanswer = vi.fn(async () => ({ ok: true }));
		const screen = render(ToolApprovalCard, {
			conversationId: "a1",
			request: request("bash", { command: "ls" }),
			onanswer,
		});
		await screen.getByRole("button", { name: "Always allow (this session)" }).click();
		expect(onanswer).toHaveBeenCalledWith("accept", "always");
	});

	describe("a key the machine's ceiling caps", () => {
		const withCeiling = (capped: AlwaysCapped, tool: string) =>
			render(ToolApprovalCard, {
				props: {
					conversationId: "a1",
					request: request(tool, { command: "ls" }),
					onanswer: async () => ({ ok: true }),
				},
				context: new Map([[ALWAYS_CAPPED, capped]]),
			} as never);

		it("hides Always allow for it, and keeps Allow once and Deny", async () => {
			const screen = withCeiling((tool) => tool === "bash", "bash");
			await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
			await expect.element(screen.getByRole("button", { name: "Deny" })).toBeVisible();
			expect(
				screen.getByRole("button", { name: "Always allow (this session)" }).elements()
			).toHaveLength(0);
		});

		it("keeps Always allow for a key it does not cap", async () => {
			const screen = withCeiling((tool) => tool === "bash", "edit");
			await expect
				.element(screen.getByRole("button", { name: "Always allow (this session)" }))
				.toBeVisible();
		});
	});

	it("does not trust a galopin flag in chat, where the arguments are a model's own", async () => {
		const screen = render(ToolApprovalCard, { conversationId: "c1", request: spawn });
		expect(screen.getByTestId("galopin-approval").elements()).toHaveLength(0);
		await expect
			.element(screen.getByRole("button", { name: "Allow for this conversation" }))
			.toBeVisible();
	});

	describe("a new subagent's first turn", () => {
		const asked = (first: boolean, over: Partial<ElicitationRequestPayload> = {}) => {
			const ensured: string[][] = [];
			const provider: FirstTurnSubagent = {
				rootMode: "allow",
				ensure: (child, ask) => void ensured.push([child, ask]),
				isFirst: () => first,
			};
			const screen = render(ToolApprovalCard, {
				props: {
					conversationId: "a1",
					request: { ...request("edit", { filePath: "x" }), childSessionId: "child-1", ...over },
					onanswer: async () => ({ ok: true }),
				},
				context: new Map([[FIRST_TURN_SUBAGENT, provider]]),
			} as never);
			return { screen, ensured };
		};

		it("says the first turn asks, with the reason on hover, and reads that subagent's transcript for this ask", async () => {
			const { screen, ensured } = asked(true);
			const chip = screen.getByTestId("first-turn-chip");
			await expect.element(chip).toHaveTextContent("New subagent · first turn asks");
			expect(chip.element().getAttribute("title")).toContain(
				"before Cerea can hand it your permission setting"
			);
			expect(ensured).toEqual([["child-1", "gp_1"]]);
		});

		it("draws no chip for a later turn, or when it cannot tell", async () => {
			const { screen } = asked(false);
			await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
			expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
		});

		it("draws no chip for the session's own ask (no subagent)", async () => {
			const provider: FirstTurnSubagent = { ensure: () => {}, isFirst: () => true };
			const screen = render(ToolApprovalCard, {
				props: {
					conversationId: "a1",
					request: request("edit", { filePath: "x" }),
					onanswer: async () => ({ ok: true }),
				},
				context: new Map([[FIRST_TURN_SUBAGENT, provider]]),
			} as never);
			await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
			expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
		});

		it("draws no chip in chat, where no provider is above the card", async () => {
			const screen = render(ToolApprovalCard, {
				conversationId: "c1",
				request: { ...request("edit", {}), childSessionId: "child-1" },
			});
			await expect.element(screen.getByRole("button", { name: /Allow/ }).first()).toBeVisible();
			expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
		});

		it("draws no chip when the root is not on Allow", async () => {
			const provider: FirstTurnSubagent = {
				rootMode: "ask",
				ensure: () => {},
				isFirst: () => true,
			};
			const screen = render(ToolApprovalCard, {
				props: {
					conversationId: "a1",
					request: { ...request("edit", {}), childSessionId: "child-1" },
					onanswer: async () => ({ ok: true }),
				},
				context: new Map([[FIRST_TURN_SUBAGENT, provider]]),
			} as never);
			await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
			expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
		});

		it("draws no chip when the root mode is unknown", async () => {
			const provider: FirstTurnSubagent = { ensure: () => {}, isFirst: () => true };
			const screen = render(ToolApprovalCard, {
				props: {
					conversationId: "a1",
					request: { ...request("edit", {}), childSessionId: "child-1" },
					onanswer: async () => ({ ok: true }),
				},
				context: new Map([[FIRST_TURN_SUBAGENT, provider]]),
			} as never);
			await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
			expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
		});

		it("draws no chip for a key the ceiling caps, where the machine-limit wording explains it", async () => {
			const provider: FirstTurnSubagent = {
				rootMode: "allow",
				ensure: () => {},
				isFirst: () => true,
			};
			const screen = render(ToolApprovalCard, {
				props: {
					conversationId: "a1",
					request: { ...request("bash", { command: "ls" }), childSessionId: "child-1" },
					onanswer: async () => ({ ok: true }),
				},
				context: new Map<symbol, unknown>([
					[FIRST_TURN_SUBAGENT, provider],
					[ALWAYS_CAPPED, ((tool: string) => tool === "bash") as AlwaysCapped],
				]),
			} as never);
			await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
			expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
		});

		it("draws no chip for a key that asks under every setting", async () => {
			const provider: FirstTurnSubagent = {
				rootMode: "allow",
				ensure: () => {},
				isFirst: () => true,
			};
			for (const tool of ["external_directory", "doom_loop"]) {
				const screen = render(ToolApprovalCard, {
					props: {
						conversationId: "a1",
						request: { ...request(tool, {}), childSessionId: "child-1" },
						onanswer: async () => ({ ok: true }),
					},
					context: new Map([[FIRST_TURN_SUBAGENT, provider]]),
				} as never);
				await expect
					.element(screen.getByRole("button", { name: "Allow once" }).first())
					.toBeVisible();
				expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
				screen.unmount();
			}
		});

		it("uses the provider's own child id when the ask carries none (the inbox)", async () => {
			const ensured: string[][] = [];
			const provider: FirstTurnSubagent = {
				rootMode: "allow",
				childId: "child-9",
				ensure: (child, ask) => void ensured.push([child, ask]),
				isFirst: () => true,
			};
			const screen = render(ToolApprovalCard, {
				props: {
					conversationId: "a1",
					request: request("edit", {}),
					onanswer: async () => ({ ok: true }),
				},
				context: new Map([[FIRST_TURN_SUBAGENT, provider]]),
			} as never);
			await expect.element(screen.getByTestId("first-turn-chip")).toBeVisible();
			expect(ensured).toEqual([["child-9", "gp_1"]]);
		});
	});
});

describe("ToolApprovalCard, a settled subagent row", () => {
	const subagentAsk = {
		...request("bash", { command: "sleep 60" }),
		childSessionId: "ses_child",
		childTitle: "Dummy 60s sleep test (@general subagent)",
	} as ElicitationRequestPayload;
	const resolved = {
		type: "elicitation",
		subtype: "resolved",
		elicitationId: "gp_1",
		action: "accept",
		resolution: "user",
	} as never;

	it("does not overflow a 390px phone: the title gives way, the outcome stays", async () => {
		const screen = render(
			ToolApprovalCard,
			{ conversationId: "a1", request: subagentAsk, resolved, onanswer: async () => ({ ok: true }) },
			{ baseElement: document.body }
		);
		const host = screen.container.parentElement as HTMLElement;
		host.style.width = "390px";
		host.style.overflow = "visible";
		const row = screen.container.querySelector("button[aria-label]") as HTMLElement;
		await expect.element(screen.getByText("Allowed")).toBeVisible();
		const rowRight = row.getBoundingClientRect().right;
		expect(rowRight).toBeLessThanOrEqual(390 + 1);
		const outcome = screen.getByText("Allowed").element().getBoundingClientRect();
		expect(outcome.right).toBeLessThanOrEqual(390 + 1);
	});

	it("settles with a short note, not an error, when the ask was already answered", async () => {
		const screen = render(ToolApprovalCard, {
			conversationId: "a1",
			request: subagentAsk,
			onanswer: async () => ({ ok: true, note: "Already answered" }),
		});
		await screen.getByRole("button", { name: "Allow once" }).click();
		await expect.element(screen.getByText("Already answered")).toBeVisible();
		expect(screen.getByText("PermissionNotFoundError").elements()).toHaveLength(0);
	});
});
