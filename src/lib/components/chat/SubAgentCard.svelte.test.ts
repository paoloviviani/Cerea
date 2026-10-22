import SubAgentCard from "./SubAgentCard.svelte";
import { render } from "vitest-browser-svelte";
import { describe, expect, it } from "vitest";
import {
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageSubAgentUpdate,
	type MessageToolUpdate,
} from "$lib/types/MessageUpdate";

const state = (over: Partial<MessageSubAgentUpdate> = {}): MessageSubAgentUpdate => ({
	type: MessageUpdateType.SubAgent,
	uuid: "u1",
	title: "Compare the licences",
	model: "Big One",
	status: "running",
	activity: "searching “licence of A”",
	steps: [
		{ tool: "web_search", label: "search “licence of A”", outcome: "ok" },
		{ tool: "web_fetch", label: "read a.test/license", outcome: "ok" },
		{ tool: "srv_do", label: "call srv_do", outcome: "refused" },
	],
	...over,
});

const result = (text: string): MessageToolUpdate =>
	({
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Result,
		uuid: "u1",
		result: {
			status: "success",
			call: { name: "delegate", parameters: {} },
			outputs: [{ text }],
			display: true,
		},
	}) as unknown as MessageToolUpdate;

const failed = (message: string): MessageToolUpdate => ({
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Error,
	uuid: "u1",
	message,
});

const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);
const click = (el: Element | null) => (el as HTMLElement).click();

describe("the sub-agent card", () => {
	it("while it works: title, model, status and the current step on a live line", () => {
		const { baseElement } = render(SubAgentCard, { update: state(), loading: true });
		expect(q(baseElement, "subagent-title")?.textContent).toBe("Compare the licences");
		expect(q(baseElement, "subagent-model")?.textContent).toBe("Big One");
		expect(q(baseElement, "subagent-status")?.textContent).toContain("Working");
		expect(q(baseElement, "subagent-activity")?.textContent).toContain("searching “licence of A”");
		expect(q(baseElement, "subagent-card")?.getAttribute("data-status")).toBe("working");
	});

	it("when finished: done, the answer previewed, no live line", () => {
		const { baseElement } = render(SubAgentCard, {
			update: state({ status: "done", activity: undefined }),
			tool: [result("A is MIT. B is Apache-2.0.")],
		});
		expect(q(baseElement, "subagent-status")?.textContent).toContain("Done");
		expect(q(baseElement, "subagent-activity")).toBeNull();
		expect(q(baseElement, "subagent-preview")?.textContent).toContain("A is MIT");
	});

	it("opens to the full answer, and a list of its steps behind a toggle", async () => {
		const { baseElement } = render(SubAgentCard, {
			update: state({ status: "done", activity: undefined }),
			tool: [result("A is MIT. B is Apache-2.0.")],
		});
		expect(q(baseElement, "subagent-result")).toBeNull();
		click(baseElement.querySelector("button[aria-expanded]"));
		await expect.poll(() => q(baseElement, "subagent-result")?.textContent).toContain("A is MIT");

		expect(q(baseElement, "subagent-steps")).toBeNull();
		click(q(baseElement, "subagent-steps-toggle"));
		await expect.poll(() => q(baseElement, "subagent-steps")).not.toBeNull();
		const rows = [...(q(baseElement, "subagent-steps")?.querySelectorAll("li") ?? [])];
		expect(rows.map((r) => r.getAttribute("data-outcome"))).toEqual(["ok", "ok", "refused"]);
		expect(rows[2].textContent).toContain("refused");
		expect(q(baseElement, "subagent-steps-toggle")?.textContent).toMatch(/3\s+steps/);
	});

	it("shows a failure as such, with its message", () => {
		const { baseElement } = render(SubAgentCard, {
			update: state({ status: "failed", activity: undefined }),
			tool: [failed("Sub-agent ran out of time without an answer.")],
		});
		expect(q(baseElement, "subagent-status")?.textContent).toContain("Failed");
		expect(q(baseElement, "subagent-preview")?.textContent).toContain("ran out of time");
	});

	it("reads as stopped when it was running in a message nobody is streaming", () => {
		const { baseElement } = render(SubAgentCard, { update: state(), loading: false });
		expect(q(baseElement, "subagent-status")?.textContent).toContain("Stopped");
		expect(q(baseElement, "subagent-activity")).toBeNull();
	});

	it("a research card carries no model chip difference, only its own icon", () => {
		const { baseElement } = render(SubAgentCard, {
			update: state({ preset: "research", title: "Why is the sky blue" }),
			loading: true,
		});
		expect(q(baseElement, "subagent-title")?.textContent).toBe("Why is the sky blue");
	});
});
