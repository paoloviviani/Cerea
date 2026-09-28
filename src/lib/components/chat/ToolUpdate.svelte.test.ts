import ToolUpdate from "./ToolUpdate.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it } from "vitest";
import { MessageToolUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import type { MessageToolUpdate } from "$lib/types/MessageUpdate";
import { ToolResultStatus } from "$lib/types/Tool";

const call = {
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Call,
	uuid: "c1",
	call: { name: "playwright_screenshot", parameters: {} },
} as MessageToolUpdate;

const result = (blocks: unknown[]): MessageToolUpdate =>
	({
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Result,
		uuid: "c1",
		result: {
			status: ToolResultStatus.Success,
			call: { name: "playwright_screenshot", parameters: {} },
			outputs: [{ text: "took a screenshot" }, { content: blocks }],
			display: true,
		},
	}) as MessageToolUpdate;

/** The card is collapsed until its header is opened. */
async function open(tool: MessageToolUpdate[]) {
	const view = renderWithApp(ToolUpdate, { tool });
	const header = view.baseElement.querySelector<HTMLButtonElement>("button[aria-label='Expand']");
	header?.click();
	await new Promise((resolve) => setTimeout(resolve, 0));
	return view.baseElement.querySelectorAll<HTMLImageElement>("img[alt^='Tool result image']");
}

describe("a tool result's images", () => {
	it("renders an inline data image, as it always has", async () => {
		const images = await open([
			call,
			result([{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }]),
		]);
		expect(images).toHaveLength(1);
		expect(images[0].getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
	});

	it("renders a coding-agent image from its same-origin url, beside a data one", async () => {
		const url = `/api/v2/code/v1/agents/s1/attachments/${"a".repeat(64)}?device=d1`;
		const images = await open([
			call,
			result([
				{ type: "image", mimeType: "image/png", url },
				{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
			]),
		]);
		expect([...images].map((i) => i.getAttribute("src"))).toEqual([
			url,
			"data:image/png;base64,iVBORw0KGgo=",
		]);
	});

	it("does not load a url that leaves this origin", async () => {
		const images = await open([
			call,
			result([
				{ type: "image", mimeType: "image/png", url: "https://evil.example/x.png" },
				{ type: "image", mimeType: "image/png", url: "//evil.example/x.png" },
				{ type: "image", mimeType: "image/png", url: "javascript:alert(1)" },
				{ type: "image", mimeType: "image/png", url: "/\\evil.example/x.png" },
			]),
		]);
		expect(images).toHaveLength(0);
	});
});
