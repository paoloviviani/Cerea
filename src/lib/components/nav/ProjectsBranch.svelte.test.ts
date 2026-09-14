import ProjectsBranch from "./ProjectsBranch.svelte";
import { renderWithApp, appNavigation } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";

const find = (root: ParentNode, selector: string): HTMLElement => {
	const el = root.querySelector<HTMLElement>(selector);
	if (!el) throw new Error(`no element matching ${selector}`);
	return el;
};

/** A project the sidebar can render, owned, with two chats already in it. */
const project = {
	id: "6aa7a824963f78d43f6764a0",
	name: "Mortgage",
	description: "",
	instructions: "",
	knowledgeBaseIds: [] as string[],
	indexPastChats: false,
	retrievalLimit: 6,
	owned: true,
	shares: [] as { kind: "user" | "group"; principal: string }[],
	conversationCount: 2,
	updatedAt: new Date().toISOString(),
};

const settingsContext = (activeModel: string) => ({
	context: new Map([["settings", writable({ activeModel })]]),
});

let posts: Array<{ url: string; body: Record<string, unknown> }>;

function stubFetch(listed: unknown, existingChats: unknown, createStatus = 200) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			if (href.endsWith("/api/v2/projects") && !init?.method) {
				return new Response(JSON.stringify({ data: [project] }), { status: 200 });
			}
			if (href.endsWith("/conversation") && init?.method === "POST") {
				posts.push({
					url: href,
					body: JSON.parse(String(init.body)) as Record<string, unknown>,
				});
				return new Response(
					JSON.stringify(
						createStatus === 200
							? { conversationId: "conv-42" }
							: { message: "You have reached the maximum number of conversations." }
					),
					{ status: createStatus }
				);
			}
			if (href.includes("/conversations") && !init?.method) {
				return new Response(JSON.stringify({ data: existingChats }), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${href}`);
		})
	);
}

beforeEach(() => {
	posts = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const openBranch = async (container: HTMLElement) => {
	find(container, "button").click();
	await vi.waitFor(() => expect(container.textContent).toContain("Mortgage"));
};

describe("ProjectsBranch: starting a chat from the row", () => {
	it("the + creates the conversation with the project attached and navigates to it", async () => {
		stubFetch(undefined, undefined);
		const onopen = vi.fn();
		const { container } = renderWithApp(
			ProjectsBranch,
			{ onopen },
			{
				page: { params: {}, data: { models: [{ id: "model-a" }, { id: "model-b" }] } },
				...settingsContext("model-b"),
			}
		);
		await openBranch(container);

		const plus = find(container, 'button[title="New chat"]');
		plus.click();
		await vi.waitFor(() => expect(appNavigation().goto).toHaveBeenCalled());

		expect(posts).toEqual([
			{ url: "/conversation", body: { model: "model-b", projectId: project.id } },
		]);
		expect(appNavigation().goto).toHaveBeenCalledWith("/conversation/conv-42");
		// The overlay was never opened: the point of the row's own +.
		expect(onopen).not.toHaveBeenCalled();
	});

	it("starting from an empty folder works from the row itself, not the overlay", async () => {
		stubFetch(undefined, []);
		const onopen = vi.fn();
		const { container } = renderWithApp(
			ProjectsBranch,
			{ onopen },
			{
				page: { params: {}, data: { models: [{ id: "model-a" }] } },
				...settingsContext("model-a"),
			}
		);
		await openBranch(container);

		// opening the folder lists nothing
		const folder = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Mortgage")
		);
		if (!folder) throw new Error("no folder row for the project");
		folder.click();
		const empty = await vi.waitFor(
			() => find(container, 'button[title="Start a chat"]') // "No chats yet"
		);
		empty.click();
		await vi.waitFor(() => expect(appNavigation().goto).toHaveBeenCalled());

		expect(posts).toEqual([
			{ url: "/conversation", body: { model: "model-a", projectId: project.id } },
		]);
		expect(onopen).not.toHaveBeenCalled();
	});

	it("a failed create says why and does not navigate", async () => {
		stubFetch(undefined, undefined, 429);
		const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
		const { container } = renderWithApp(
			ProjectsBranch,
			{ onopen: vi.fn() },
			{
				page: { params: {}, data: { models: [{ id: "model-a" }] } },
				...settingsContext("model-a"),
			}
		);
		await openBranch(container);

		find(container, 'button[title="New chat"]').click();
		await vi.waitFor(() =>
			expect(alert).toHaveBeenCalledWith("You have reached the maximum number of conversations.")
		);
		expect(appNavigation().goto).not.toHaveBeenCalled();
	});
});
