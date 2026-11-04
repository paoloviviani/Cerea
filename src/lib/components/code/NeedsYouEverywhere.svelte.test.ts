import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import NeedsYouInbox from "./NeedsYouInbox.svelte";
import NeedsYouShell from "./NeedsYouShell.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { codeNeedsYou, claimSessions, clearPending } from "$lib/stores/codeNeedsYou.svelte";
import { codeReauth, resetCodeReauth } from "$lib/stores/codeReauth.svelte";

/**
 * The Needs-you inbox beyond /code: pinned to a chat's own sessions, as the
 * app-wide bar, and the shell's mounting rules. The machines are fakes;
 * what is under test is which asks are listed, how they start (collapsed
 * or expanded), and when nothing is drawn or requested at all.
 */
const fake = vi.hoisted(() => ({
	pendingByDevice: {} as Record<string, { permissions: unknown[]; questions: unknown[] }>,
	listCalls: 0,
	/** What the machine list read answers (the shell starts the shared device poll). */
	deviceList: [] as unknown[],
}));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listPendingApprovals: async (deviceId: string) => {
		fake.listCalls += 1;
		return JSON.parse(
			JSON.stringify(fake.pendingByDevice[deviceId] ?? { permissions: [], questions: [] })
		);
	},
	listDevices: async () => ({ devices: fake.deviceList }),
	respondPermission: async () => ({ ok: true }),
	respondQuestion: async () => ({ ok: true }),
	getAgent: async () => ({ agent: { permissionMode: "allow" } }),
}));

vi.mock("$lib/codeAgentStream", () => ({
	agentStreamUrl: () => "",
	async *codeAgentStream(_device: string, _agent: string, signal: AbortSignal) {
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
	},
}));

function permission(sessionId: string, requestId: string, title = "Run the tests") {
	return {
		sessionId,
		workspaceId: "w1",
		sessionTitle: `Session ${sessionId}`,
		request: {
			id: requestId,
			sessionId,
			tool: "bash",
			title,
			patterns: [],
			metadata: {},
			always: [],
		},
	};
}

const EXPANDED_KEY = "code.inbox.expanded";
const bar = () => document.body.querySelector('[data-testid="needs-you-inbox"]');
const pinned = () => document.body.querySelector('[data-testid="needs-you-pinned"]');
const items = () => document.body.querySelectorAll('[data-testid="needs-you-item"]');

function devices() {
	fake.deviceList = [{ id: "d1", name: "Box", status: "paired", online: true }];
	codeDeviceList.devices = fake.deviceList as typeof codeDeviceList.devices;
	codeDeviceList.loading = false;
}

beforeEach(async () => {
	await browserPage.viewport(1200, 800);
	fake.pendingByDevice = {
		d1: {
			permissions: [permission("a1", "p1"), permission("a2", "p2", "Edit a file")],
			questions: [],
		},
	};
	fake.listCalls = 0;
	fake.deviceList = [];
	codeDeviceList.devices = [];
	document.body.innerHTML = "";
	sessionStorage.clear();
	resetCodeReauth();
	clearPending();
});
afterEach(() => {
	document.body.innerHTML = "";
});

describe("NeedsYouInbox pinned to sessions", () => {
	it("lists only those sessions' asks, expanded without being opened", async () => {
		devices();
		renderWithApp(NeedsYouInbox, { sessions: [{ deviceId: "d1", sessionId: "a2" }] });
		await vi.waitFor(() => expect(pinned()).not.toBeNull());
		expect(bar()).toBeNull();
		expect(items()).toHaveLength(1);
		expect(pinned()?.textContent).toContain("Session a2");
		expect(pinned()?.textContent).not.toContain("Session a1");
		expect(pinned()?.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe(
			"true"
		);
		// The pinned view keeps its choice to itself: the bar's remembered state is untouched.
		expect(sessionStorage.getItem(EXPANDED_KEY)).toBeNull();
	});

	it("draws nothing when its sessions have nothing pending", async () => {
		devices();
		renderWithApp(NeedsYouInbox, { sessions: [{ deviceId: "d1", sessionId: "zz" }] });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(pinned()).toBeNull();
	});
});

describe("NeedsYouInbox as the app-wide bar", () => {
	it("starts collapsed as '2 need you' and leaves out sessions another instance claimed", async () => {
		devices();
		const release = claimSessions([{ deviceId: "d1", sessionId: "a1" }]);
		renderWithApp(NeedsYouInbox, { publish: true, scroll: true });
		await vi.waitFor(() => expect(bar()).not.toBeNull());
		// Collapsed: one line, and it counts only what it would list.
		expect(items()).toHaveLength(0);
		expect(bar()?.textContent).toContain("1 needs you");
		// What is pending in total is still published for the sidebar badge.
		await vi.waitFor(() => expect(codeNeedsYou.pending).toHaveLength(2));
		bar()?.querySelector("button")?.click();
		await vi.waitFor(() => expect(items()).toHaveLength(1));
		expect(bar()?.textContent).toContain("Session a2");
		expect(bar()?.textContent).not.toContain("Session a1");
		release();
		await vi.waitFor(() => expect(bar()?.textContent).toContain("2 need you"));
	});

	it("clears what it published when it goes away", async () => {
		devices();
		const screen = renderWithApp(NeedsYouInbox, { publish: true });
		await vi.waitFor(() => expect(codeNeedsYou.pending).toHaveLength(2));
		screen.unmount();
		expect(codeNeedsYou.pending).toHaveLength(0);
	});
});

describe("NeedsYouShell mounting rules", () => {
	function mount(route: string, enabled = true) {
		return renderWithApp(NeedsYouShell, { enabled }, { page: { route: { id: route }, data: {} } });
	}
	const fresh = () => {
		codeReauth.checked = true;
		codeReauth.required = false;
	};

	it("draws the bar on an ordinary page once the sign-in is known fresh", async () => {
		devices();
		fresh();
		mount("/projects");
		await vi.waitFor(() => expect(bar()).not.toBeNull());
		expect(bar()?.textContent).toContain("2 need you");
	});

	it("is absent on /code, which draws its own", async () => {
		devices();
		fresh();
		mount("/code");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(bar()).toBeNull();
		expect(fake.listCalls).toBe(0);
	});

	it("is absent on the sign-in routes", async () => {
		devices();
		fresh();
		mount("/login/callback");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(bar()).toBeNull();
		expect(fake.listCalls).toBe(0);
	});

	it("asks nothing and draws nothing with /code disabled, a stale sign-in, or before /status answered", async () => {
		devices();
		fresh();
		mount("/projects", false).unmount();
		resetCodeReauth();
		codeReauth.checked = true;
		codeReauth.required = true;
		mount("/projects").unmount();
		resetCodeReauth();
		mount("/projects").unmount();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(bar()).toBeNull();
		expect(fake.listCalls).toBe(0);
	});

	it("draws nothing with no paired machine, and makes no ask", async () => {
		codeDeviceList.devices = [];
		codeDeviceList.loading = false;
		fresh();
		mount("/projects");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(bar()).toBeNull();
		expect(fake.listCalls).toBe(0);
	});
});
