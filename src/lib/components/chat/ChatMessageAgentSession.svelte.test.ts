/** A stored `agentSession` update becomes a card in the message, in order (ADR 0106 §4). */
import { describe, it, expect } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import ChatMessage from "./ChatMessage.svelte";
import { MessageUpdateType } from "$lib/types/MessageUpdate";

const card = (action: "started" | "prompted", sessionId: string, title: string) => ({
	type: MessageUpdateType.AgentSession,
	action,
	deviceId: "d1",
	workspaceId: "w1",
	sessionId,
	title,
	labels: { device: "Studio laptop", workspace: "cerea" },
});

describe("an agent session in a message", () => {
	it("draws one card per start or prompt, from the stored updates alone", () => {
		const view = renderWithApp(
			ChatMessage,
			{
				message: {
					id: "m1",
					from: "assistant",
					content: "Started it.",
					children: [],
					updates: [card("started", "s1", "First job"), card("prompted", "s1", "First job")],
				},
				loading: false,
				isLast: false,
				readOnly: false,
			} as never,
			{ page: { data: {} } }
		);
		const cards = view.baseElement.querySelectorAll('[data-testid="agent-session-card"]');
		expect(cards).toHaveLength(2);
		expect(cards[0].getAttribute("data-action")).toBe("started");
		expect(cards[1].getAttribute("data-action")).toBe("prompted");
		expect(view.baseElement.textContent).toContain("Started · Studio laptop › cerea");
	});
});
