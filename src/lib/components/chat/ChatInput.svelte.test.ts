import ChatInput from "./ChatInput.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";

// The composer's MCP stores read `$env/dynamic/public` at module scope; the
// client project runs in a real browser where no SvelteKit env exists.
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

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
 * trust check. (Copied from ProjectsBranch's harness, for the same reason.)
 */
const fireTap = (el: HTMLElement) => {
	el.focus();
	el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
};

const stores = [
	{ id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Specs", description: "" },
	{ id: "bbbbbbbbbbbbbbbbbbbbbbbb", name: "Minutes", description: "" },
];

const CONV_ID = "0123456789abcdef01234567";

function stubFetch(overrides: { patchStatus?: number } = {}) {
	const calls: Array<{ method: string; url: string; body: unknown }> = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const href = String(url);
			const method = init?.method ?? "GET";
			calls.push({ method, url: href, body: init?.body ? JSON.parse(String(init.body)) : null });
			if (href.endsWith("/api/v2/gateway/vector_stores") && method === "GET") {
				return new Response(JSON.stringify({ data: stores }), { status: 200 });
			}
			if (href.endsWith(`/conversation/${CONV_ID}`) && method === "PATCH") {
				return new Response(JSON.stringify({ message: "boom" }), {
					status: overrides.patchStatus ?? 200,
				});
			}
			throw new Error(`unexpected fetch: ${method} ${href}`);
		})
	);
	return calls;
}

const settingsContext = new Map<string, unknown>([["settings", writable({ activeModel: "m" })]]);

async function renderComposer(
	params: Record<string, string>,
	attached: { id: string; name: string }[] = []
) {
	let host = document.getElementById("app");
	if (!host) {
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	}
	const mounted = renderWithApp(
		ChatInput,
		{ knowledgeBases: attached, mimeTypes: ["text/plain", "image/png"] },
		{
			page: {
				params,
				data: { user: { username: "tester" }, loginEnabled: true, shared: false },
			},
			baseElement: host,
			context: settingsContext,
		}
	);
	return { ...mounted, container: host };
}

beforeEach(() => {
	document.getElementById("app")?.remove();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.getElementById("app")?.remove();
});

const openMenu = async (container: HTMLElement) => {
	fireTap(find(container, 'button[aria-label="Add attachment"]'));
	await vi.waitFor(() => expect(document.body.textContent).toContain("Knowledge bases"));
};

const openKnowledgeSubmenu = async (_container: HTMLElement) => {
	const trigger = [...document.body.querySelectorAll("div")].find((el) =>
		el.textContent?.trim().startsWith("Knowledge bases")
	);
	if (!trigger) throw new Error("no knowledge submenu trigger");
	trigger.click();
	await vi.waitFor(() => expect(document.body.textContent).toContain("Specs"));
};

describe("ChatInput: attaching knowledge bases", () => {
	it("lists the caller's bases in the submenu and toggles one on with a PATCH", async () => {
		const calls = stubFetch();
		const { container } = await renderComposer({ id: CONV_ID });
		await openMenu(container);
		await openKnowledgeSubmenu(container);

		const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
			(el) => el.textContent?.includes("Specs")
		);
		if (!item) throw new Error("no Specs checkbox item");
		expect(item.getAttribute("aria-checked")).toBe("false");
		item.click();

		await vi.waitFor(() =>
			expect(calls).toContainEqual({
				method: "PATCH",
				url: expect.stringContaining(`/conversation/${CONV_ID}`),
				body: { knowledgeBaseIds: ["aaaaaaaaaaaaaaaaaaaaaaaa"] },
			})
		);
		expect(item.getAttribute("aria-checked")).toBe("true");
	});

	it("toggling off sends the shortened list", async () => {
		const calls = stubFetch();
		const { container } = await renderComposer({ id: CONV_ID }, [
			{ id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "Specs" },
		]);
		await openMenu(container);
		await openKnowledgeSubmenu(container);

		const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
			(el) => el.textContent?.includes("Specs")
		);
		if (!item) throw new Error("no Specs checkbox item");
		expect(item.getAttribute("aria-checked")).toBe("true");
		item.click();

		await vi.waitFor(() =>
			expect(calls).toContainEqual({
				method: "PATCH",
				url: expect.stringContaining(`/conversation/${CONV_ID}`),
				body: { knowledgeBaseIds: [] },
			})
		);
		expect(item.getAttribute("aria-checked")).toBe("false");
	});

	it("a refused attach rolls the toggle back", async () => {
		stubFetch({ patchStatus: 400 });
		const { container } = await renderComposer({ id: CONV_ID });
		await openMenu(container);
		await openKnowledgeSubmenu(container);

		const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
			(el) => el.textContent?.includes("Specs")
		);
		if (!item) throw new Error("no Specs checkbox item");
		item.click();

		await vi.waitFor(() => expect(item.getAttribute("aria-checked")).toBe("false"));
	});

	it("before a conversation exists, toggling stays local and PATCHes nothing", async () => {
		const calls = stubFetch();
		const { container } = await renderComposer({});
		await openMenu(container);
		await openKnowledgeSubmenu(container);

		const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(
			(el) => el.textContent?.includes("Specs")
		);
		if (!item) throw new Error("no Specs checkbox item");
		item.click();

		await vi.waitFor(() => expect(item.getAttribute("aria-checked")).toBe("true"));
		expect(calls.filter((call) => call.method === "PATCH")).toEqual([]);
	});

	it("an anonymous composer never reaches the knowledge submenu", async () => {
		stubFetch();
		let host = document.getElementById("app");
		if (!host) {
			host = document.createElement("div");
			host.id = "app";
			document.body.appendChild(host);
		}
		renderWithApp(
			ChatInput,
			{ mimeTypes: ["text/plain", "image/png"] },
			{
				page: { params: {}, data: { loginEnabled: true, shared: false } },
				baseElement: host,
				context: settingsContext,
			}
		);
		// requireAuthUser() closes the dropdown outright for an anonymous
		// session — the menu itself never opens, so no submenu inside it either.
		fireTap(find(host, 'button[aria-label="Add attachment"]'));
		await vi.waitFor(() => expect(document.body.textContent).not.toContain("Add text file"));
		expect(document.body.textContent).not.toContain("Knowledge bases");
	});
});
