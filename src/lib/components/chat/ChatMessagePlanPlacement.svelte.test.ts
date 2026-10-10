import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import ChatMessage from "./ChatMessage.svelte";
import { MessageUpdateType } from "$lib/types/MessageUpdate";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 })));
afterEach(() => vi.unstubAllGlobals());

const call = (uuid: string) => ({
	type: "tool",
	subtype: "call",
	uuid,
	call: { name: "bash", parameters: { command: "ls" } },
});
const result = (uuid: string) => ({
	type: "tool",
	subtype: "result",
	uuid,
	result: {
		status: 0,
		call: { name: "bash", parameters: { command: "ls" } },
		outputs: [{ text: "ok" }],
		display: true,
	},
});
const plan = (uuid: string, version: number, step: string) => ({
	type: MessageUpdateType.Plan,
	uuid,
	goal: step,
	version,
	steps: [{ step, status: "in_progress" }],
});

const mount = (updates: unknown[], content = "The answer.") =>
	render(ChatMessage, {
		message: { id: "m1", from: "assistant", content, children: [], updates },
		loading: false,
		isLast: true,
		isAuthor: true,
		readOnly: false,
	} as never);

const text = (view: ReturnType<typeof mount>) => view.baseElement.textContent ?? "";
const planCards = (view: ReturnType<typeof mount>) =>
	view.baseElement.querySelectorAll('button[aria-label$="plan"]').length;

describe("the coding agent's task plan inside a message", () => {
	it("never shows the agent's task plan as a card: one process group, no plan text", () => {
		const view = mount([
			call("a"),
			result("a"),
			plan("agent-plan-s1", 1, "Write the view"),
			call("b"),
			result("b"),
		]);
		const out = text(view);
		// one summary for both calls, not "Called 1 tool" twice
		expect(out).toContain("Called 2 tools");
		expect(out).not.toContain("Called 1 tool");
		expect(planCards(view)).toBe(0);
		expect(out).not.toContain("Write the view");
	});

	it("a later agent plan update still shows no card, and the todowrite row stays", () => {
		const view = mount([
			plan("agent-plan-s1", 1, "First plan"),
			{
				type: "tool",
				subtype: "call",
				uuid: "t1",
				call: { name: "todowrite", parameters: { steps: [] } },
			},
			{
				type: "tool",
				subtype: "result",
				uuid: "t1",
				result: {
					status: 0,
					call: { name: "todowrite", parameters: { steps: [] } },
					outputs: [{ text: "ok" }],
					display: true,
				},
			},
			plan("agent-plan-s1", 2, "Second plan"),
		]);
		expect(planCards(view)).toBe(0);
		expect(text(view)).not.toContain("First plan");
		expect(text(view)).not.toContain("Second plan");
		// the todowrite call stays in the process group: it is the record that
		// the plan changed
		expect(text(view)).toContain("Called tool todowrite");
	});

	it("leaves a chat plan (keyed by its call id) at its stream position", () => {
		const view = mount([
			call("a"),
			result("a"),
			plan("call-plan-1", 1, "Chat plan"),
			call("b"),
			result("b"),
		]);
		const out = text(view);
		// two separate single-tool rows with the plan between them, as before
		expect(out).not.toContain("Called 2 tools");
		const first = out.indexOf("Called tool bash");
		const second = out.lastIndexOf("Called tool bash");
		expect(first).toBeLessThan(out.indexOf("Chat plan"));
		expect(out.indexOf("Chat plan")).toBeLessThan(second);
	});
});
