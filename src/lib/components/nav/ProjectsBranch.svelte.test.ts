import ProjectsBranch from "./ProjectsBranch.svelte";
import { renderWithApp, appNavigation } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { ACTIVE_GENERATIONS_CONTEXT_KEY } from "$lib/stores/activeGenerations.svelte";

const find = (root: ParentNode, selector: string): HTMLElement => {
	const el = root.querySelector<HTMLElement>(selector);
	if (!el) throw new Error(`no element matching ${selector}`);
	return el;
};

/**
 * Open a bits-ui dropdown from a test. Its trigger opens on a *trusted*
 * pointerdown or on Enter — and vitest-browser-svelte's container lives in
 * the page, not in a shadow root, but a synthetic `pointerdown` carries
 * `isTrusted: false` and is ignored. Focusing the trigger and dispatching a
 * synthetic keydown Enter reaches the trigger's own handler, which has no
 * trust check.
 */
const fireTap = (el: HTMLElement) => {
	el.focus();
	el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
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

const existingChat = {
	id: "conv-1",
	title: "First chat",
	model: "model-a",
	updatedAt: new Date().toISOString(),
};

/**
 * The modals the rows open mount through a Portal and, on mount, mark
 * `#app` inert. The test harness renders into a bare div, so provide that
 * element first and render into it.
 */
async function renderBranch(model: string) {
	let host = document.getElementById("app");
	if (!host) {
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	}
	const mounted = renderWithApp(
		ProjectsBranch,
		{},
		{
			page: { params: {}, data: { models: [{ id: model }] } },
			baseElement: host,
			...settingsContext(model),
		}
	);
	return { ...mounted, container: host };
}

const settingsContext = (activeModel: string) => ({
	context: new Map<string, unknown>([
		["settings", writable({ activeModel })],
		// NavConversationItem asks this store for the live-turn badge. The class
		// is not exported, but the shape the rows read is just these three.
		[
			ACTIVE_GENERATIONS_CONTEXT_KEY,
			{
				has: () => false,
				statusFor: () => undefined,
				setRunning: () => undefined,
			} as {
				has: (id: string | object) => boolean;
				statusFor: (
					id: string | object
				) => "running" | "waiting" | "awaiting_input" | "failed" | undefined;
				setRunning: (ids: string[]) => void;
			},
		],
	]),
});

let posts: Array<{ url: string; body: Record<string, unknown> }>;

function stubFetch(listed: unknown, existingChats: unknown, createStatus = 200) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			const method = init?.method ?? "GET";
			if (href.endsWith("/api/v2/projects") && method === "GET") {
				return new Response(JSON.stringify({ data: [project] }), { status: 200 });
			}
			if (href.endsWith("/conversation") && method === "POST") {
				posts.push({
					url: href.replace(/^https?:\/\/[^/]+/, ""),
					body: JSON.parse(String(init?.body)) as Record<string, unknown>,
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
			if (href.includes("/projects/") && href.endsWith("/conversations") && method === "GET") {
				return new Response(JSON.stringify({ data: existingChats }), { status: 200 });
			}
			if (href.match(/\/api\/v2\/conversations\/(conv-1|conv-42)$/) && method !== "GET") {
				posts.push({
					url: href.replace(/^https?:\/\/[^/]+/, ""),
					body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
				});
				return new Response(JSON.stringify({ success: true }), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${method} ${href}`);
		})
	);
}

beforeEach(() => {
	posts = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.getElementById("app")?.remove();
});

const openBranch = async (container: HTMLElement) => {
	find(container, "button").click();
	await vi.waitFor(() => expect(container.textContent).toContain("Mortgage"));
};

describe("ProjectsBranch: starting a chat from the row", () => {
	it("the + creates the conversation with the project attached and navigates to it", async () => {
		stubFetch(undefined, undefined);
		const { container } = await renderBranch("model-b");
		await openBranch(container);

		const plus = find(container, 'button[title="New chat"]');
		plus.click();
		await vi.waitFor(() => expect(appNavigation().goto).toHaveBeenCalled());

		expect(posts).toEqual([
			{ url: "/conversation", body: { model: "model-b", projectId: project.id } },
		]);
		expect(appNavigation().goto).toHaveBeenCalledWith("/conversation/conv-42");
		// No project page was opened: the point of the row's own +.
		expect(appNavigation().goto).not.toHaveBeenCalledWith(expect.stringContaining("/projects/"));
	});

	it("starting from an empty folder works from the row itself, not the project page", async () => {
		stubFetch(undefined, []);
		const { container } = await renderBranch("model-a");
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
		expect(appNavigation().goto).not.toHaveBeenCalledWith(expect.stringContaining("/projects/"));
	});

	it("a failed create says why and does not navigate", async () => {
		stubFetch(undefined, undefined, 429);
		const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
		const { container } = await renderBranch("model-a");
		await openBranch(container);

		find(container, 'button[title="New chat"]').click();
		await vi.waitFor(() =>
			expect(alert).toHaveBeenCalledWith("You have reached the maximum number of conversations.")
		);
		expect(appNavigation().goto).not.toHaveBeenCalled();
	});

	it("a chat's own menu renames it in place", async () => {
		stubFetch(undefined, [existingChat]);
		const { container } = await renderBranch("model-a");
		await openBranch(container);

		// open the folder, the chat row appears with its `⋯`
		const folder = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Mortgage")
		);
		if (!folder) throw new Error("no folder row for the project");
		folder.click();
		const rail = await vi.waitFor(() => {
			const el = container.querySelector<HTMLElement>(".border-l");
			if (!el) throw new Error("no project chat guide rail yet");
			return el;
		});
		expect(rail.textContent).toContain("First chat");
		const menu = await vi.waitFor(() => find(container, 'button[title="More options"]'));
		fireTap(menu);

		const rename = await vi.waitFor(() => {
			const el = [...document.querySelectorAll("[role='menuitem']")].find((b) =>
				b.textContent?.includes("Rename")
			);
			if (!el) throw new Error("no rename item yet");
			return el as HTMLElement;
		});
		// bits-ui items select on Enter (their own keydown handler) or a
		// detail-0 click; a synthetic keydown reaches both.
		rename.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		// The rename modal mounts through a Portal into document.body and focuses
		// its input on a timer; wait for the input to exist, then type into it.
		const input = await vi.waitFor(() => {
			const el = document.querySelector<HTMLInputElement>("input#conv-title");
			if (!el) throw new Error("no rename input yet");
			return el;
		});
		input.value = "Renamed chat";
		input.dispatchEvent(new Event("input", { bubbles: true }));

		const save = [...document.querySelectorAll("button")].find((b) => b.textContent === "Save");
		if (!save) throw new Error("no save button");
		save.click();

		await vi.waitFor(() =>
			expect(posts).toEqual([
				{
					url: "/api/v2/conversations/conv-1",
					body: { title: "Renamed chat" },
				},
			])
		);
		await vi.waitFor(() => expect(container.textContent).toContain("Renamed chat"));
	});

	it("a chat's own menu deletes it, and the folder updates at once", async () => {
		stubFetch(undefined, [existingChat]);
		const { container } = await renderBranch("model-a");
		await openBranch(container);

		const folder = [...container.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Mortgage")
		);
		if (!folder) throw new Error("no folder row for the project");
		folder.click();
		const menu = await vi.waitFor(() => find(container, 'button[title="More options"]'));
		fireTap(menu);

		const del = await vi.waitFor(() => {
			const el = [...document.querySelectorAll("[role='menuitem']")].find((b) =>
				b.textContent?.includes("Delete")
			);
			if (!el) throw new Error("no delete item yet");
			return el as HTMLElement;
		});
		del.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		const confirm = await vi.waitFor(() => {
			const el = [...document.querySelectorAll("button")].find((b) => b.textContent === "Delete");
			if (!el) throw new Error("no confirm button yet");
			return el as HTMLElement;
		});
		confirm.click();

		await vi.waitFor(() =>
			expect(posts).toEqual([{ url: "/api/v2/conversations/conv-1", body: {} }])
		);
		// gone from the folder; the count follows
		await vi.waitFor(() => expect(container.textContent).not.toContain("First chat"));
		await vi.waitFor(() => {
			const el = [...container.querySelectorAll("span")].find((s) => s.textContent === "1");
			if (!el) throw new Error("no count badge yet");
		});
	});
});

describe("ProjectsBranch: managing a project is a page, not an overlay", () => {
	it("the header + goes to /projects/new", async () => {
		stubFetch(undefined, undefined);
		const { container } = await renderBranch("model-a");
		await openBranch(container);

		find(container, 'button[title="New project"]').click();
		await vi.waitFor(() => expect(appNavigation().goto).toHaveBeenCalledWith("/projects/new"));
	});

	it("the row's menu has one entry, Settings, which goes to the project's page, beside Delete", async () => {
		stubFetch(undefined, undefined);
		const { container } = await renderBranch("model-a");
		await openBranch(container);

		find(container, 'button[aria-label="Manage Mortgage"]').click();
		const items = await vi.waitFor(() => {
			const found = [...document.querySelectorAll("[role='menuitem']")];
			if (found.length === 0) throw new Error("menu not open yet");
			return found as HTMLElement[];
		});
		expect(items.map((item) => item.textContent?.trim())).toEqual(["Settings", "Delete"]);

		items[0].click();
		await vi.waitFor(() =>
			expect(appNavigation().goto).toHaveBeenCalledWith(`/projects/${project.id}`)
		);
	});
});
