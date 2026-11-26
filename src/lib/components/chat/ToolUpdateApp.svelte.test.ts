import ToolUpdate from "./ToolUpdate.svelte";
import { render } from "vitest-browser-svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageToolUpdate,
} from "$lib/types/MessageUpdate";
import { ToolResultStatus } from "$lib/types/Tool";

const route = vi.hoisted(() => ({ params: { id: "conv1" } as Record<string, string> }));
vi.mock("$app/state", () => ({
	page: {
		get params() {
			return route.params;
		},
		data: {},
		url: new URL("http://localhost/"),
	},
}));

const app = {
	connector: "connector:1",
	server: "Maps",
	tool: "show_map",
	uri: "ui://maps/view",
	sha256: "b".repeat(64),
	size: 10,
};

function updates(withApp: boolean): MessageToolUpdate[] {
	return [
		{
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Call,
			uuid: "u1",
			call: { name: "show_map", parameters: { q: "pizza" } },
			argumentsRaw: '{"q":"pizza"}',
		},
		{
			type: MessageUpdateType.Tool,
			subtype: MessageToolUpdateType.Result,
			uuid: "u1",
			result: {
				status: ToolResultStatus.Success,
				call: { name: "show_map", parameters: { q: "pizza" } },
				outputs: [{ text: "3 results" }],
				display: true,
				...(withApp ? { app } : {}),
			},
		},
	] as MessageToolUpdate[];
}

afterEach(() => {
	vi.unstubAllGlobals();
	route.params = { id: "conv1" };
});

describe("ToolUpdate with an MCP App page", () => {
	it("shows the page under the header, with the card still closed, when the result carries one", async () => {
		const fetched: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				fetched.push(String(input));
				return new Response("<p>hi</p>", { status: 200 });
			})
		);

		const view = render(ToolUpdate, { tool: updates(true) });
		await vi.waitFor(() =>
			expect(view.baseElement.querySelector("[data-testid='mcp-app']")).not.toBeNull()
		);

		// The page is read once the card is near the screen and laid out, not at once.
		await vi.waitFor(() => expect(fetched.length).toBeGreaterThan(0));
		expect(fetched[0]).toContain("/conversation/conv1/mcp-app/" + "b".repeat(64));
		await vi.waitFor(() => expect(view.baseElement.querySelector("iframe")).not.toBeNull());
		expect(view.baseElement.querySelector("iframe")?.getAttribute("sandbox") ?? "").not.toContain(
			"allow-same-origin"
		);
	});

	it("shows the text result as before when it carries no page", async () => {
		const view = render(ToolUpdate, { tool: updates(false) });

		expect(view.baseElement.querySelector("[data-testid='mcp-app']")).toBeNull();
		expect(view.baseElement.textContent).toContain("Used tool");
	});

	it("shows no page outside a conversation (a shared link cannot read the stored page)", async () => {
		route.params = {};
		const view = render(ToolUpdate, { tool: updates(true) });

		expect(view.baseElement.querySelector("[data-testid='mcp-app']")).toBeNull();
	});
});
