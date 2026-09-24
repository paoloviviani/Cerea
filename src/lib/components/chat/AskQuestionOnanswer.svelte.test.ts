/**
 * The user-question tool design's own answer path: AskQuestion.svelte's
 * `onanswer` prop, added for the agent-initiated question tool so the
 * SAME card answers through the /code forwarder's `question.reply` route
 * instead of chat's elicitation endpoint. A separate file rather than an
 * addition to AskQuestion.svelte.test.ts (owned by chat's own
 * ask_user_question feature, feat/ask-question) to avoid touching it.
 */
import AskQuestion from "./AskQuestion.svelte";
import { render } from "vitest-browser-svelte";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { ElicitationField, ElicitationRequestPayload } from "$lib/types/McpElicitation";

let calledFetch: boolean;

beforeEach(() => {
	calledFetch = false;
	vi.stubGlobal("fetch", async () => {
		calledFetch = true;
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	});
});

afterEach(() => vi.unstubAllGlobals());

const field = (name: string): ElicitationField =>
	({
		kind: "select",
		name,
		title: name,
		description: "Which package manager?",
		required: true,
		multiple: false,
		options: [
			{ value: "npm", label: "npm" },
			{ value: "pnpm", label: "pnpm" },
		],
	}) as ElicitationField;

const request: ElicitationRequestPayload = {
	elicitationId: "q-1",
	source: "assistant",
	server: "pystino",
	mode: "form",
	message: "",
	fields: [field("q0")],
};

const rowFor = (el: HTMLElement, text: string) =>
	[...el.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find((b) =>
		(b.textContent ?? "").includes(text)
	);
const button = (el: HTMLElement, label: string) =>
	[...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().startsWith(label));

describe("AskQuestion's onanswer prop (machine-originated questions)", () => {
	it("routes an accepted answer through onanswer instead of the chat fetch", async () => {
		const onanswer = vi.fn(async (action: string, content?: Record<string, unknown>) => {
			expect(action).toBe("accept");
			expect(content).toEqual({ q0: "pnpm" });
			return { ok: true };
		});
		const { baseElement } = render(AskQuestion, { conversationId: "agent-1", request, onanswer });

		rowFor(baseElement, "pnpm")?.click();
		button(baseElement, "Send")?.click();

		await vi.waitFor(() => expect(onanswer).toHaveBeenCalledTimes(1));
		expect(calledFetch).toBe(false);
	});

	it("routes a decline through onanswer with no content", async () => {
		const onanswer = vi.fn(async () => ({ ok: true }));
		const { baseElement } = render(AskQuestion, { conversationId: "agent-1", request, onanswer });

		button(baseElement, "Skip")?.click();

		await vi.waitFor(() => expect(onanswer).toHaveBeenCalledTimes(1));
		expect(onanswer).toHaveBeenCalledWith("decline", undefined);
		expect(calledFetch).toBe(false);
	});

	it("surfaces onanswer's error instead of settling the card", async () => {
		const onanswer = vi.fn(async () => ({ ok: false, error: "machine went offline" }));
		const { baseElement } = render(AskQuestion, { conversationId: "agent-1", request, onanswer });

		rowFor(baseElement, "npm")?.click();
		button(baseElement, "Send")?.click();

		await vi.waitFor(() => expect(baseElement.textContent).toContain("machine went offline"));
	});
});
