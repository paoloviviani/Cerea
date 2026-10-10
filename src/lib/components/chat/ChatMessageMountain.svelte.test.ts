import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { page as browserPage } from "@vitest/browser/context";
import ChatMessage from "./ChatMessage.svelte";

beforeEach(() => vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 })));
afterEach(() => vi.unstubAllGlobals());

const call = (uuid: string) => ({
	type: "tool",
	subtype: "call",
	uuid,
	call: { name: "bash", parameters: { command: "npm test" } },
});
const result = (uuid: string) => ({
	type: "tool",
	subtype: "result",
	uuid,
	result: {
		status: 0,
		call: { name: "bash", parameters: { command: "npm test" } },
		outputs: [{ text: "94 passed" }],
		display: true,
	},
});

/** A running turn whose last message ended on a completed tool call: the
 * inline progress mark — the mountain where the three dots used to be —
 * rides at the bottom of the content flow. */
const mount = () =>
	render(ChatMessage, {
		message: {
			id: "m1",
			from: "assistant",
			content: "",
			children: [],
			updates: [call("t1"), result("t1")],
		},
		loading: true,
		isLast: true,
		isAuthor: true,
		readOnly: false,
	} as never);

const markHeight = (view: ReturnType<typeof mount>): number => {
	const svg = view.baseElement.querySelector('svg[shape-rendering="crispEdges"]');
	if (!svg) return 0;
	return Math.round(svg.getBoundingClientRect().height);
};

describe("the inline progress mark", () => {
	it("is 16px on a desktop and the previous 12px on a phone", async () => {
		await browserPage.viewport(1440, 900);
		const desktop = mount();
		expect(markHeight(desktop)).toBe(16);

		await browserPage.viewport(390, 800);
		const phone = mount();
		expect(markHeight(phone)).toBe(12);
	});
});
