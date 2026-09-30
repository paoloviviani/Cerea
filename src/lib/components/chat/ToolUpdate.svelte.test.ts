import ToolUpdate from "./ToolUpdate.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { MessageToolUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import type { MessageToolUpdate } from "$lib/types/MessageUpdate";
import { ToolResultStatus } from "$lib/types/Tool";
import { CODE_SESSION_LINKS } from "$lib/utils/codeSessionLinks";

const call = {
	type: MessageUpdateType.Tool,
	subtype: MessageToolUpdateType.Call,
	uuid: "c1",
	call: { name: "playwright_screenshot", parameters: {} },
} as MessageToolUpdate;

const resultOf = (outputs: unknown[]): MessageToolUpdate =>
	({
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Result,
		uuid: "c1",
		result: {
			status: ToolResultStatus.Success,
			call: { name: "playwright_screenshot", parameters: {} },
			outputs,
			display: true,
		},
	}) as MessageToolUpdate;

const result = (blocks: unknown[]): MessageToolUpdate =>
	resultOf([{ text: "took a screenshot" }, { content: blocks }]);

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
		const url = `/api/v2/code/v1/agents/s1/attachments/${"a".repeat(64)}?device=${"b".repeat(24)}`;
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

	it("loads nothing but the attachment route, even from this origin", async () => {
		const sha = "a".repeat(64);
		const device = "b".repeat(24);
		const hostile = [
			"/api/v2/conversation/abc/delete",
			"/logout",
			`/api/v2/code/v1/agents/s1/attachments/${sha}?device=${device}&x=1`,
			`/api/v2/code/v1/agents/s1/attachments/${sha}`,
			`/api/v2/code/v1/agents/s1/attachments/${"A".repeat(64)}?device=${device}`,
			`/api/v2/code/v1/agents/s1/attachments/${sha}?device=d1`,
			`/api/v2/code/v1/agents/../../../logout/attachments/${sha}?device=${device}`,
			`/api/v2/code/v1/agents/s1/attachments/${sha}?device=${device}#frag`,
		];
		const images = await open([
			call,
			result(hostile.map((url) => ({ type: "image", mimeType: "image/png", url }))),
		]);
		expect(images).toHaveLength(0);
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

describe("the collapsed card's thumbnail strip", () => {
	const device = "b".repeat(24);
	const urlOf = (n: number) =>
		`/api/v2/code/v1/agents/s1/attachments/${n.toString(16).padStart(64, "0")}?device=${device}`;
	const urlImage = (n: number, size = 1000) => ({
		type: "image",
		mimeType: "image/png",
		url: urlOf(n),
		size,
	});
	const withNotShown = (blocks: unknown[], imagesNotShown: number): MessageToolUpdate =>
		resultOf([
			{ text: "took a screenshot" },
			{ content: blocks },
			{ text: `${imagesNotShown} not shown`, imagesNotShown },
		]);

	const strip = (view: ReturnType<typeof renderWithApp>) =>
		view.container.querySelector<HTMLElement>("[data-testid='tool-image-strip']");
	const thumbs = (view: ReturnType<typeof renderWithApp>) =>
		view.container.querySelectorAll<HTMLImageElement>("[data-testid='tool-image-strip'] img");
	const more = (view: ReturnType<typeof renderWithApp>) =>
		view.container.querySelector<HTMLElement>("[data-testid='tool-image-more']");

	it("shows nothing for a result without images", () => {
		const view = renderWithApp(ToolUpdate, { tool: [call, resultOf([{ text: "hi" }])] });
		expect(strip(view)).toBeNull();
	});

	it("shows one image as one 48px thumbnail with its alt text, and no chip", () => {
		const view = renderWithApp(ToolUpdate, { tool: [call, result([urlImage(1)])] });
		expect(thumbs(view)).toHaveLength(1);
		expect(thumbs(view)[0].alt).toBe("Tool result image 1 of 1");
		expect(thumbs(view)[0].getAttribute("loading")).toBe("lazy");
		expect(thumbs(view)[0].getAttribute("decoding")).toBe("async");
		expect(more(view)).toBeNull();
		const box = thumbs(view)[0].parentElement?.getBoundingClientRect();
		expect([box?.width, box?.height]).toEqual([48, 48]);
	});

	it("shows three of five, and counts the rest in a +N chip", () => {
		const view = renderWithApp(ToolUpdate, {
			tool: [call, result([1, 2, 3, 4, 5].map((n) => urlImage(n)))],
		});
		expect(thumbs(view)).toHaveLength(3);
		expect(thumbs(view)[2].alt).toBe("Tool result image 3 of 5");
		expect(more(view)?.textContent?.trim()).toBe("+2");
	});

	it("dedupes a repeated screenshot by its hash", () => {
		const view = renderWithApp(ToolUpdate, {
			tool: [call, result([urlImage(1), urlImage(1), urlImage(2), urlImage(1)])],
		});
		expect(thumbs(view)).toHaveLength(2);
		expect(more(view)).toBeNull();
	});

	it("adds images the machine or Cerea left out to the chip", () => {
		const view = renderWithApp(ToolUpdate, {
			tool: [
				call,
				withNotShown(
					[1, 2, 3, 4].map((n) => urlImage(n)),
					3
				),
			],
		});
		expect(more(view)?.textContent?.trim()).toBe("+4");
		const onlyOmitted = renderWithApp(ToolUpdate, { tool: [call, withNotShown([], 2)] });
		expect(thumbs(onlyOmitted)).toHaveLength(0);
		expect(more(onlyOmitted)?.textContent?.trim()).toBe("+2");
	});

	it("holds a large image back until it is tapped", async () => {
		const view = renderWithApp(ToolUpdate, {
			tool: [call, result([urlImage(1, 5.2 * 1024 * 1024), urlImage(2, 1000)])],
		});
		const gated = view.container.querySelector<HTMLButtonElement>(
			"[data-testid='tool-image-gated']"
		);
		expect(gated?.textContent?.replace(/\s+/g, " ").trim()).toBe("image · 5.2 MB — tap to load");
		// Only the small one has a request behind it.
		expect(thumbs(view)).toHaveLength(1);
		expect(gated?.getBoundingClientRect().height).toBe(48);
		// Position in the name, so several gated images are told apart.
		expect(gated?.getAttribute("aria-label")).toBe("Load image 1 of 2 (5.2 MB)");
		gated?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(thumbs(view)).toHaveLength(2);
		expect(view.container.querySelector("[data-testid='tool-image-gated']")).toBeNull();
	});

	it("reserves each box before its image arrives: nothing moves when it loads", async () => {
		const view = renderWithApp(ToolUpdate, { tool: [call, result([urlImage(1), urlImage(2)])] });
		const rect = () => strip(view)?.getBoundingClientRect().toJSON();
		const before = rect();
		const img = thumbs(view)[0];
		await new Promise<void>((resolve) => {
			if (img.complete) resolve();
			img.addEventListener("load", () => resolve());
			img.addEventListener("error", () => resolve());
		});
		expect(rect()).toEqual(before);
		expect(before?.height).toBe(48);
	});

	it("keeps the header on one line at a narrow width, the strip on its own line under it", async () => {
		await browserPage.viewport(320, 700);
		const view = renderWithApp(ToolUpdate, {
			tool: [call, result([1, 2, 3, 4].map((n) => urlImage(n)))],
		});
		const header = view.container.querySelector<HTMLElement>("button[aria-label='Expand']");
		expect(header?.getBoundingClientRect().height).toBeLessThan(28);
		const stripBox = strip(view)?.getBoundingClientRect();
		expect(stripBox?.top).toBeGreaterThanOrEqual(header?.getBoundingClientRect().bottom ?? 0);
		expect(stripBox?.right).toBeLessThanOrEqual(320);
		expect(thumbs(view)).toHaveLength(3);
		await browserPage.viewport(1200, 800);
		const wide = renderWithApp(ToolUpdate, { tool: [call, result([urlImage(1)])] });
		expect(thumbs(wide)).toHaveLength(1);
	});

	it("opens the image on tap and the whole card from the chip; expanding hides the strip", async () => {
		const view = renderWithApp(ToolUpdate, {
			tool: [call, result([1, 2, 3, 4].map((n) => urlImage(n)))],
		});
		thumbs(view)[0].parentElement?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(document.querySelector("[aria-label='Close']")).not.toBeNull();
		document.querySelector<HTMLElement>("[aria-label='Close']")?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		more(view)?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(strip(view)).toBeNull();
		expect(view.container.querySelectorAll("img[alt^='Tool result image']")).toHaveLength(4);
	});
});

describe("between-session tools in an agent transcript", () => {
	const links = {
		href: (id: string) => `/code?device=d1&ws=w1&agent=${id}`,
		title: (id: string) => (id === "ses_b" ? "Docs agent" : undefined),
	};
	const withLinks = (tool: MessageToolUpdate[]) =>
		renderWithApp(ToolUpdate, { tool }, { context: new Map([[CODE_SESSION_LINKS, links]]) });
	const tool = (name: string, parameters: Record<string, unknown>, text?: string) =>
		[
			{
				type: MessageUpdateType.Tool,
				subtype: MessageToolUpdateType.Call,
				uuid: name,
				call: { name, parameters },
			},
			...(text === undefined
				? []
				: [
						{
							type: MessageUpdateType.Tool,
							subtype: MessageToolUpdateType.Result,
							uuid: name,
							result: {
								status: ToolResultStatus.Success,
								call: { name, parameters },
								outputs: [{ text }],
								display: true,
							},
						},
					]),
		] as MessageToolUpdate[];

	it("reads a send as Sent to ‹title›, linked to the target", async () => {
		const view = withLinks(tool("session_send", { target: "ses_b", text: "hi" }, "{}"));
		await expect.element(view.getByText("Sent to")).toBeVisible();
		const link = view.baseElement.querySelector<HTMLAnchorElement>("[data-testid='session-link']");
		expect(link?.textContent?.trim()).toBe("Docs agent");
		expect(link?.getAttribute("href")).toBe("/code?device=d1&ws=w1&agent=ses_b");
	});

	it("reads a spawn as Spawned ‹title›, linked to the child it returned", async () => {
		const view = withLinks(
			tool("session_spawn", { title: "Migration review", prompt: "x" }, '{"sessionId":"ses_c"}')
		);
		await expect.element(view.getByText("Spawned")).toBeVisible();
		const link = view.baseElement.querySelector<HTMLAnchorElement>("[data-testid='session-link']");
		expect(link?.textContent?.trim()).toBe("Migration review");
		expect(link?.getAttribute("href")).toContain("agent=ses_c");
	});

	it("badges a send the machine approved without a card", async () => {
		const view = withLinks(
			tool("session_send", { target: "ses_b", text: "hi" }, '{"autoApproved":true}')
		);
		await expect.element(view.getByText("Sent to")).toBeVisible();
		await expect.element(view.getByText("auto-approved")).toBeVisible();
	});

	it("shows no badge on a send that was asked", async () => {
		const view = withLinks(tool("session_send", { target: "ses_b", text: "hi" }, "{}"));
		await expect.element(view.getByText("Sent to")).toBeVisible();
		expect(view.baseElement.querySelector("[data-testid='auto-approved-badge']")).toBeNull();
	});

	it("badges a spawn the machine approved without a card", async () => {
		const view = withLinks(
			tool(
				"session_spawn",
				{ title: "Migration review", prompt: "x" },
				'{"sessionId":"ses_c","title":"Migration review","mode":"build","autoApproved":true}'
			)
		);
		await expect.element(view.getByText("Spawned")).toBeVisible();
		await expect.element(view.getByText("auto-approved")).toBeVisible();
	});

	it("shows no badge on a spawn that was asked", async () => {
		const view = withLinks(
			tool("session_spawn", { title: "Docs", prompt: "x" }, '{"sessionId":"ses_d"}')
		);
		await expect.element(view.getByText("Spawned")).toBeVisible();
		expect(view.baseElement.querySelector("[data-testid='auto-approved-badge']")).toBeNull();
	});

	it("does not say a refused spawn happened", async () => {
		const view = withLinks(
			tool("session_spawn", { title: "Docs", prompt: "x" }, "The person declined.")
		);
		await expect.element(view.getByText("Called tool")).toBeVisible();
		expect(view.baseElement.querySelector("[data-testid='session-link']")).toBeNull();
	});

	it("renders as the plain tool card outside an agent view", async () => {
		const view = renderWithApp(ToolUpdate, {
			tool: tool("session_send", { target: "ses_b", text: "hi" }, "{}"),
		});
		await expect.element(view.getByText("Called tool")).toBeVisible();
		expect(view.baseElement.querySelector("[data-testid='session-link']")).toBeNull();
	});
});
