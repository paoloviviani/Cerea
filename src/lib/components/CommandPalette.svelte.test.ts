import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { userEvent } from "@vitest/browser/context";
import { renderWithApp, appNavigation } from "$lib/components/__tests__/renderWithApp";
import CommandPalette from "./CommandPalette.svelte";
import { projectsTreeCache } from "$lib/stores/projectsTreeCache.svelte";
import { codeTreeCache } from "$lib/stores/codeTreeCache.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const api = vi.hoisted(() => ({ listSchedules: vi.fn() }));
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	...api,
}));

const chats = [
	{ id: "c1", title: "Plan the offsite", updatedAt: new Date(), model: "m" },
	{ id: "c2", title: "Budget 2027", updatedAt: new Date(), model: "m" },
];

function press(key: string, init: KeyboardEventInit = {}) {
	window.dispatchEvent(
		new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
	);
}

describe("CommandPalette", () => {
	let host: HTMLElement;

	beforeEach(() => {
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
		projectsTreeCache.loaded = false;
		projectsTreeCache.projects = [];
		projectsTreeCache.chats = {};
		codeTreeCache.trees = {};
		codeDeviceList.devices = [];
		api.listSchedules.mockReset();
		api.listSchedules.mockResolvedValue({
			schedules: [{ id: "s1", kind: "chat", name: "Weekly news" }],
			limit: 20,
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [{ id: "p1", name: "Budget project" }] }))
		);
	});

	afterEach(() => {
		document.getElementById("app")?.removeAttribute("inert");
		vi.unstubAllGlobals();
		host.remove();
	});

	function mount(data: Record<string, unknown> = {}, gatewayIsAdmin = false) {
		return renderWithApp(CommandPalette, { conversations: chats, gatewayIsAdmin } as never, {
			baseElement: host,
			page: { data: { user: { id: "u" }, chatSchedulesEnabled: true, ...data } },
		});
	}
	const options = () =>
		[...document.querySelectorAll('[data-testid="palette-option"]')].map((el) => ({
			text: el.textContent?.replace(/\s+/g, " ").trim() ?? "",
			kind: el.getAttribute("data-kind"),
		}));

	it("is closed until Ctrl-K or ⌘K, and the same key closes it", async () => {
		mount();
		expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
		press("k", { ctrlKey: true });
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="command-palette"]')).not.toBeNull()
		);
		press("k", { metaKey: true });
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="command-palette"]')).toBeNull()
		);
		// Other letters, and K with Shift, do nothing.
		press("k", { ctrlKey: true, shiftKey: true });
		press("j", { ctrlKey: true });
		expect(document.querySelector('[data-testid="command-palette"]')).toBeNull();
	});

	it("jumps to chats, projects, schedules and settings pages as you type", async () => {
		mount({ usageEnabled: true });
		press("k", { ctrlKey: true });
		await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
		// Projects and schedules arrive after the palette opens.
		await vi.waitFor(() => expect(options().some((o) => o.kind === "project")).toBe(true));
		await vi.waitFor(() => expect(options().some((o) => o.kind === "schedule")).toBe(true));

		const input = document.querySelector('[data-testid="palette-input"]') as HTMLInputElement;
		await userEvent.type(input, "budget");
		await vi.waitFor(() =>
			expect(options().map((o) => o.text)).toEqual(["Budget 2027", "Budget project"])
		);
		await userEvent.keyboard("{ArrowDown}{Enter}");
		expect(appNavigation().goto).toHaveBeenLastCalledWith("/projects/p1");
	});

	it("opens a chat with Enter on the best match", async () => {
		mount();
		press("k", { ctrlKey: true });
		const input = await vi.waitFor(() => {
			const el = document.querySelector('[data-testid="palette-input"]') as HTMLInputElement;
			expect(el).not.toBeNull();
			return el;
		});
		await userEvent.type(input, "offsite{Enter}");
		expect(appNavigation().goto).toHaveBeenLastCalledWith("/conversation/c1");
		await vi.waitFor(() =>
			expect(document.querySelector('[data-testid="command-palette"]')).toBeNull()
		);
	});

	it("finds settings and workspace pages, and Admin only for administrators", async () => {
		mount({ usageEnabled: true }, false);
		press("k", { ctrlKey: true });
		const input = (await vi.waitFor(() => {
			const el = document.querySelector('[data-testid="palette-input"]');
			expect(el).not.toBeNull();
			return el;
		})) as HTMLInputElement;
		await userEvent.type(input, "usage");
		await vi.waitFor(() =>
			expect(options().map((o) => o.text)).toEqual(["Usage & billing Settings"])
		);
		await userEvent.clear(input);
		await userEvent.type(input, "admin");
		await vi.waitFor(() => expect(options()).toEqual([]));
	});

	it("lists agent sessions from the machines' cache, only where agents are on", async () => {
		codeDeviceList.devices = [{ id: "d1", name: "Build box", status: "paired" }] as never;
		codeTreeCache.trees = {
			d1: {
				workspaces: [{ id: "w1", name: "cerea", path: "/c", isGitRepo: true }],
				agents: [{ id: "a1", workspaceId: "w1", title: "Fix flaky test" }],
				off: false,
			},
		} as never;
		mount({ codeAgentsEnabled: true });
		press("k", { ctrlKey: true });
		const input = (await vi.waitFor(() => {
			const el = document.querySelector('[data-testid="palette-input"]');
			expect(el).not.toBeNull();
			return el;
		})) as HTMLInputElement;
		await userEvent.type(input, "flaky");
		await vi.waitFor(() =>
			expect(options()).toEqual([{ text: "Fix flaky test Build box › cerea", kind: "agent" }])
		);
		await userEvent.keyboard("{Enter}");
		expect(appNavigation().goto).toHaveBeenLastCalledWith("/code?device=d1&ws=w1&agent=a1");
	});

	it("says nothing matches", async () => {
		mount();
		press("k", { ctrlKey: true });
		const input = (await vi.waitFor(() => {
			const el = document.querySelector('[data-testid="palette-input"]');
			expect(el).not.toBeNull();
			return el;
		})) as HTMLInputElement;
		await userEvent.type(input, "zzzzqq");
		await vi.waitFor(() => expect(document.body.textContent).toContain("Nothing matches."));
	});
});
