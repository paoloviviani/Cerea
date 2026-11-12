import BrowseCard from "./BrowseCard.svelte";
import { render } from "vitest-browser-svelte";
import { describe, expect, it } from "vitest";
import {
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageBrowseUpdate,
	type MessageToolUpdate,
} from "$lib/types/MessageUpdate";

const state = (over: Partial<MessageBrowseUpdate> = {}): MessageBrowseUpdate => ({
	type: MessageUpdateType.Browse,
	uuid: "u1",
	goal: "Find the cheapest shoe",
	model: "m",
	status: "running",
	activity: "Click 'Search' on shop.example.com",
	steps: [
		{
			id: 1,
			action: "Type into 'Search' on shop.example.com",
			page: "Shop",
			state: "ok",
			note: "typed 5 characters",
		},
		{ id: 2, action: "Click 'Search' on shop.example.com", page: "Shop", state: "running" },
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
			call: { name: "browse", parameters: {} },
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

describe("the browse card, the page left open", () => {
	it("says which page it left open, and when the resumed page had changed", async () => {
		const { baseElement } = render(BrowseCard, {
			update: state({
				status: "done",
				activity: undefined,
				leftOpen: "Flights to Oslo",
				pageChanged: true,
			}),
			loading: false,
		});
		click(baseElement.querySelector("button[aria-expanded]"));
		await Promise.resolve();
		expect(q(baseElement, "browse-left-open")?.textContent ?? "").toContain(
			"Left open: Flights to Oslo"
		);
		expect(q(baseElement, "browse-page-changed")).not.toBeNull();
	});

	it("says nothing about it while the task works, or when nothing was left", () => {
		const working = render(BrowseCard, {
			update: state({ leftOpen: "Flights" }),
			loading: true,
		});
		expect(q(working.baseElement, "browse-left-open")).toBeNull();
		const none = render(BrowseCard, { update: state({ status: "done" }), loading: false });
		click(none.baseElement.querySelector("button[aria-expanded]"));
		expect(q(none.baseElement, "browse-left-open")).toBeNull();
	});
});

describe("the browse card", () => {
	it("while it works: open, with the steps streaming in and the page each ran on", () => {
		const { baseElement } = render(BrowseCard, { update: state(), loading: true });
		expect(q(baseElement, "browse-card")?.getAttribute("data-status")).toBe("working");
		expect(q(baseElement, "browse-title")?.textContent).toContain("Find the cheapest shoe");
		expect(q(baseElement, "browse-status")?.textContent).toContain("Browsing");
		const rows = baseElement.querySelectorAll('[data-testid="browse-steps"] li');
		expect(rows).toHaveLength(2);
		expect(rows[0].textContent).toContain("Type into 'Search'");
		expect(rows[0].textContent).toContain("Shop");
		expect(rows[0].textContent).toContain("typed 5 characters");
		expect(rows[1].getAttribute("data-state")).toBe("running");
	});

	it("waiting on an approval: says so, with the sentence", () => {
		const { baseElement } = render(BrowseCard, {
			update: state({ status: "waiting", waitingOn: "Click 'Pay €120' on shop.example.com" }),
			loading: true,
		});
		expect(q(baseElement, "browse-card")?.getAttribute("data-status")).toBe("waiting");
		expect(q(baseElement, "browse-status")?.textContent).toContain("Waiting for you");
		expect(q(baseElement, "browse-waiting")?.textContent).toContain("Click 'Pay €120'");
	});

	it("when done: collapsed, with the report previewed as plain text", () => {
		const { baseElement } = render(BrowseCard, {
			update: state({
				status: "done",
				activity: undefined,
				finalUrl: "https://shop.example.com/x",
			}),
			tool: [result(JSON.stringify({ result: "The **Blue shoe** is €55.", steps: 2 }))],
		});
		expect(q(baseElement, "browse-status")?.textContent).toContain("Done");
		expect(q(baseElement, "browse-steps")).toBeNull();
		expect(q(baseElement, "browse-preview")?.textContent).toContain("The Blue shoe is €55.");
	});

	it("opens to the steps and the full report", async () => {
		const { baseElement } = render(BrowseCard, {
			update: state({
				status: "done",
				activity: undefined,
				finalUrl: "https://shop.example.com/x",
			}),
			tool: [result(JSON.stringify({ result: "The Blue shoe is €55." }))],
		});
		click(baseElement.querySelector("button[aria-expanded]"));
		await Promise.resolve();
		await new Promise((r) => setTimeout(r, 30));
		expect(q(baseElement, "browse-steps")).not.toBeNull();
		expect(q(baseElement, "browse-result")?.textContent).toContain("The Blue shoe is €55.");
		expect(q(baseElement, "browse-final-url")?.textContent).toContain("https://shop.example.com/x");
	});

	it("shows a refused action as refused, and why it stopped", () => {
		const { baseElement } = render(BrowseCard, {
			update: state({
				status: "stopped",
				stoppedReason: "max_steps",
				activity: undefined,
				steps: [
					{
						id: 1,
						action: "Click 'Pay €120' on shop.example.com",
						state: "denied",
						note: "refused by you",
					},
				],
			}),
			tool: [result(JSON.stringify({ result: "I could not pay.", stopped_reason: "max_steps" }))],
		});
		click(baseElement.querySelector("button[aria-expanded]"));
		return new Promise<void>((resolve) =>
			setTimeout(() => {
				expect(q(baseElement, "browse-card")?.getAttribute("data-status")).toBe("stopped");
				expect(baseElement.querySelector('[data-state="denied"]')?.textContent).toContain(
					"refused"
				);
				expect(q(baseElement, "browse-stop-note")?.textContent).toContain("all the steps");
				resolve();
			}, 30)
		);
	});

	it("shows a failure from the call", () => {
		const { baseElement } = render(BrowseCard, {
			update: state({ status: "failed", activity: undefined }),
			tool: [failed("Browsing failed: no machine")],
		});
		expect(q(baseElement, "browse-card")?.getAttribute("data-status")).toBe("failed");
		expect(q(baseElement, "browse-preview")?.textContent).toContain("no machine");
	});

	it("reads as stopped, not running, in a message nobody is streaming", () => {
		const { baseElement } = render(BrowseCard, { update: state(), loading: false });
		expect(q(baseElement, "browse-card")?.getAttribute("data-status")).toBe("stopped");
		const waiting = render(BrowseCard, {
			update: state({ status: "waiting", waitingOn: "x" }),
			loading: false,
		});
		expect(q(waiting.baseElement, "browse-waiting")).toBeNull();
	});

	it("does not overflow a phone-width column", async () => {
		const { container } = render(BrowseCard, {
			update: state({
				goal: "A very long goal ".repeat(12),
				steps: [{ id: 1, action: "Click 'x' ".repeat(30), page: "P ".repeat(60), state: "ok" }],
			}),
			loading: true,
		});
		container.style.width = "320px";
		await new Promise((r) => setTimeout(r, 30));
		expect(container.scrollWidth).toBeLessThanOrEqual(container.clientWidth + 1);
	});
});
