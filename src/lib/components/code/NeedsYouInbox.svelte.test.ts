import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import NeedsYouInbox from "./NeedsYouInbox.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { MessageElicitationUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import { livePage } from "./codeNavPage.svelte";
import { flushSync } from "svelte";

vi.mock("$app/state", async () => {
	const { livePage } = await import("./codeNavPage.svelte");
	return {
		page: livePage,
		navigating: { from: null, to: null, type: null, willUnload: false, delta: undefined },
		updated: { current: false, check: async () => false },
	};
});

const EXPANDED_KEY = "code.inbox.expanded";

/**
 * The machines are fakes: `listPendingApprovals` answers per device from the
 * test's own fixtures, replies only record their calls, and each session's
 * tail stream yields whatever resolved frames the test configured before
 * hanging until abort. What is under test is the inbox's own decisions:
 * what it lists, what it answers with, where each item links, and what makes
 * an ask vanish.
 */
const fake = vi.hoisted(() => ({
	pendingByDevice: {} as Record<string, { permissions: unknown[]; questions: unknown[] }>,
	permissionCalls: [] as unknown[][],
	questionCalls: [] as unknown[][],
	streamFrames: {} as Record<string, unknown[]>,
	/** Held until the test releases it, so presence can be asserted first. */
	streamGate: null as null | (() => void),
	/** Each subagent's own transcript, by session id (MOCK of the timeline route). */
	timelines: {} as Record<string, unknown[]>,
	/** Root modes by session id (MOCK of the agent snapshot read); absent means allow. */
	rootModes: {} as Record<string, string>,
	/** When true the snapshot read fails, so the mode is unknown. */
	failAgent: false,
}));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listPendingApprovals: async (deviceId: string) =>
		JSON.parse(
			JSON.stringify(fake.pendingByDevice[deviceId] ?? { permissions: [], questions: [] })
		),
	fetchSubagentTimeline: async (_device: string, _root: string, child: string) => ({
		updates: fake.timelines[child] ?? [],
	}),
	respondPermission: async (...args: unknown[]) => {
		fake.permissionCalls.push(args);
		return { ok: true };
	},
	respondQuestion: async (...args: unknown[]) => {
		fake.questionCalls.push(args);
		return { ok: true };
	},
	getAgent: async (_device: string, agent: string) => {
		if (fake.failAgent) throw new Error("no snapshot");
		return { agent: { permissionMode: fake.rootModes[agent] ?? "allow" } };
	},
}));

vi.mock("$lib/codeAgentStream", () => ({
	agentStreamUrl: () => "",
	async *codeAgentStream(_device: string, agent: string, signal: AbortSignal) {
		if ((fake.streamFrames[agent] ?? []).length > 0) {
			// Held until the test asserts presence first — a stream that
			// resolves instantly would clear the item before any assertion
			// could observe it.
			await new Promise<void>((resolve) => {
				fake.streamGate = resolve;
				signal.addEventListener("abort", () => resolve());
			});
		}
		for (const frame of fake.streamFrames[agent] ?? []) yield frame;
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
	},
}));

function permission(sessionId = "a1", requestId = "perm-1", over: Record<string, unknown> = {}) {
	return {
		sessionId,
		workspaceId: "w1",
		sessionTitle: "Build it",
		request: {
			id: requestId,
			sessionId,
			tool: "bash",
			title: "Run the tests",
			patterns: [],
			metadata: {},
			always: [],
		},
		...over,
	};
}

function question(sessionId = "a2", requestId = "que-1") {
	return {
		sessionId,
		workspaceId: "w1",
		sessionTitle: "Second",
		request: {
			id: requestId,
			questions: [
				{ question: "Which package manager?", options: [{ label: "npm" }, { label: "pnpm" }] },
			],
		},
	};
}

/** Mounted expanded unless a test says otherwise: most of these tests are about
 * the cards, which the bar only shows once opened. */
function mount(
	device = { id: "d1", name: "Box", status: "paired", online: true },
	expanded = true
) {
	if (expanded) sessionStorage.setItem(EXPANDED_KEY, "1");
	codeDeviceList.devices = [device] as typeof codeDeviceList.devices;
	codeDeviceList.loading = false;
	return renderWithApp(NeedsYouInbox);
}

const inbox = () => document.body.querySelector('[data-testid="needs-you-inbox"]');

beforeEach(() => {
	fake.pendingByDevice = {};
	fake.permissionCalls = [];
	fake.questionCalls = [];
	fake.streamFrames = {};
	fake.streamGate = null;
	fake.timelines = {};
	fake.rootModes = {};
	fake.failAgent = false;
	codeDeviceList.devices = [];
	codeDeviceList.loading = false;
	document.body.innerHTML = "";
	sessionStorage.clear();
	livePage.url = new URL("http://localhost:3000/code");
});

describe("NeedsYouInbox", () => {
	it("renders nothing when nothing is pending", async () => {
		fake.pendingByDevice = { d1: { permissions: [], questions: [] } };
		await browserPage.viewport(1200, 800);
		mount();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(inbox()).toBeNull();
	});

	it("lists a permission on desktop with its context, answers once, and deep-links it", async () => {
		fake.pendingByDevice = { d1: { permissions: [permission()], questions: [] } };
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await expect.element(screen.getByTestId("needs-you-inbox")).toBeVisible();
		await expect.element(screen.getByTestId("needs-you-item")).toBeVisible();
		expect(inbox()?.textContent).toContain("Build it");
		expect(inbox()?.textContent).toContain("Box");
		expect(inbox()?.textContent).toContain("bash");

		const link = inbox()?.querySelector('a[href*="agent=a1"]');
		expect(link?.getAttribute("href")).toContain("device=d1");
		expect(link?.getAttribute("href")).toContain("ws=w1");

		await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
		await screen.getByRole("button", { name: "Allow once" }).click();
		await vi.waitFor(() => expect(fake.permissionCalls).toEqual([["d1", "a1", "perm-1", "once"]]));
		await vi.waitFor(() => expect(inbox()).toBeNull());
	});

	it("lists and answers the same permission on a phone viewport", async () => {
		fake.pendingByDevice = { d1: { permissions: [permission()], questions: [] } };
		await browserPage.viewport(400, 800);
		const screen = mount();
		await expect.element(screen.getByTestId("needs-you-inbox")).toBeVisible();
		await screen.getByRole("button", { name: "Allow once" }).click();
		await vi.waitFor(() => expect(fake.permissionCalls).toEqual([["d1", "a1", "perm-1", "once"]]));
		await vi.waitFor(() => expect(inbox()).toBeNull());
	});

	it("lists a question with the shared question card and declines it", async () => {
		fake.pendingByDevice = { d1: { permissions: [], questions: [question()] } };
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await expect.element(screen.getByTestId("needs-you-inbox")).toBeVisible();
		await expect.element(screen.getByText("Which package manager?")).toBeVisible();
		await expect.element(screen.getByText("npm", { exact: true })).toBeVisible();
		await screen.getByRole("button", { name: "Skip" }).click();
		await vi.waitFor(() =>
			expect(fake.questionCalls).toEqual([["d1", "a2", "que-1", "decline", undefined]])
		);
		await vi.waitFor(() => expect(inbox()).toBeNull());
	});

	it("vanishes an ask answered on the agent card, through its tail stream", async () => {
		fake.pendingByDevice = { d1: { permissions: [permission()], questions: [] } };
		fake.streamFrames = {
			a1: [
				{
					type: MessageUpdateType.Elicitation,
					subtype: MessageElicitationUpdateType.Resolved,
					elicitationId: "perm-1",
					action: "accept",
					resolution: "user",
				},
			],
		};
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await expect.element(screen.getByTestId("needs-you-inbox")).toBeVisible();
		// No click anywhere: releasing the held resolved frame on the
		// session's own stream is what clears it — the answer given on the
		// agent card.
		await vi.waitFor(() => expect(fake.streamGate).not.toBeNull());
		fake.streamGate?.();
		await vi.waitFor(() => expect(inbox()).toBeNull(), { timeout: 5000 });
		expect(fake.permissionCalls).toEqual([]);
	});

	it("answers a subagent's ask through its root and links at the child", async () => {
		fake.pendingByDevice = {
			d1: { permissions: [permission("child-1", "perm-9", { rootId: "root-1" })], questions: [] },
		};
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await expect.element(screen.getByTestId("needs-you-inbox")).toBeVisible();
		expect(inbox()?.querySelector('a[href*="agent=child-1"]')).not.toBeNull();
		await screen.getByRole("button", { name: "Allow once" }).click();
		await vi.waitFor(() =>
			expect(fake.permissionCalls).toEqual([["d1", "root-1", "perm-9", "once", "child-1"]])
		);
		await vi.waitFor(() => expect(inbox()).toBeNull());
	});
});

describe("NeedsYouInbox Always allow", () => {
	const withPolicy = (max: Record<string, string>) => ({
		id: "d1",
		name: "Box",
		status: "paired",
		online: true,
		policy: { workspaceRoots: [], allowFreeModels: false, permission: { max } },
	});

	it("is labelled as this session's exception, and is offered for a key the machine does not cap", async () => {
		fake.pendingByDevice = { d1: { permissions: [permission()], questions: [] } };
		await browserPage.viewport(1200, 800);
		const screen = mount(withPolicy({ webfetch: "ask" }));
		await expect
			.element(screen.getByRole("button", { name: "Always allow (this session)" }))
			.toBeVisible();
	});

	it("still offers it for a key the machine's own ceiling holds below allow (bash asks by default)", async () => {
		fake.pendingByDevice = { d1: { permissions: [permission()], questions: [] } };
		await browserPage.viewport(1200, 800);
		const screen = mount(withPolicy({ bash: "ask" }));
		await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Always allow (this session)" }))
			.toBeVisible();
	});

	it("offers it on every machine's ask, whatever its ceiling", async () => {
		fake.pendingByDevice = {
			d1: { permissions: [permission("a1", "perm-1")], questions: [] },
			d2: { permissions: [permission("a2", "perm-2")], questions: [] },
		};
		await browserPage.viewport(1200, 800);
		codeDeviceList.devices = [
			withPolicy({ bash: "ask" }),
			{ ...withPolicy({}), id: "d2", name: "Open box" },
		] as unknown as typeof codeDeviceList.devices;
		codeDeviceList.loading = false;
		sessionStorage.setItem(EXPANDED_KEY, "1");
		const screen = renderWithApp(NeedsYouInbox);
		await expect.element(screen.getByTestId("needs-you-item").first()).toBeVisible();
		await vi.waitFor(() => expect(screen.getByTestId("needs-you-item").elements()).toHaveLength(2));
		// Both cards offer it: the ceiling no longer hides a human's "always".
		expect(
			screen.getByRole("button", { name: "Always allow (this session)" }).elements()
		).toHaveLength(2);
	});
});

describe("NeedsYouInbox a new subagent's first turn", () => {
	it("names it on a subagent's ask, read from that subagent's transcript", async () => {
		fake.pendingByDevice = {
			d1: {
				permissions: [permission("child-1", "perm-1", { rootId: "root-1" })],
				questions: [],
			},
		};
		fake.timelines = { "child-1": [{ type: "user", text: "look around" }] };
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await expect
			.element(screen.getByTestId("first-turn-chip"))
			.toHaveTextContent("New subagent · first turn asks");
	});

	it("does not name it once that subagent has had another turn", async () => {
		fake.pendingByDevice = {
			d1: {
				permissions: [permission("child-1", "perm-1", { rootId: "root-1" })],
				questions: [],
			},
		};
		fake.timelines = {
			"child-1": [
				{ type: "user", text: "look around" },
				{ type: "user", text: "now this" },
			],
		};
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
	});

	it("does not name it on a top-level session's ask", async () => {
		fake.pendingByDevice = {
			d1: { permissions: [permission("root-1", "perm-1", { rootId: "root-1" })], questions: [] },
		};
		fake.timelines = { "root-1": [{ type: "user", text: "start" }] };
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
	});

	it("does not name it when the root is not on Allow", async () => {
		fake.pendingByDevice = {
			d1: {
				permissions: [permission("child-1", "perm-1", { rootId: "root-1" })],
				questions: [],
			},
		};
		fake.timelines = { "child-1": [{ type: "user", text: "look around" }] };
		fake.rootModes = { "root-1": "ask" };
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
	});

	it("does not name it when the root mode cannot be read", async () => {
		fake.pendingByDevice = {
			d1: {
				permissions: [permission("child-1", "perm-1", { rootId: "root-1" })],
				questions: [],
			},
		};
		fake.timelines = { "child-1": [{ type: "user", text: "look around" }] };
		fake.failAgent = true;
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
	});
});

describe("NeedsYouInbox collapsed bar", () => {
	it("starts as a one-line bar with the count, cards hidden", async () => {
		fake.pendingByDevice = {
			d1: { permissions: [permission("a1", "perm-1")], questions: [question("a2", "que-1")] },
		};
		await browserPage.viewport(1200, 800);
		const screen = mount(undefined, false);
		await expect.element(screen.getByTestId("needs-you-inbox")).toBeVisible();
		const toggle = screen.getByRole("button", { name: "2 need you" });
		await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
		expect(screen.getByTestId("needs-you-item").elements()).toHaveLength(0);
		expect(screen.getByRole("button", { name: "Allow once" }).elements()).toHaveLength(0);
	});

	it("says '1 needs you' for one", async () => {
		fake.pendingByDevice = { d1: { permissions: [permission()], questions: [] } };
		await browserPage.viewport(1200, 800);
		const screen = mount(undefined, false);
		await expect.element(screen.getByRole("button", { name: "1 needs you" })).toBeVisible();
	});

	it("expands on a click, remembers it for the browser session, and collapses again", async () => {
		fake.pendingByDevice = { d1: { permissions: [permission()], questions: [] } };
		await browserPage.viewport(1200, 800);
		const first = mount(undefined, false);
		await first.getByRole("button", { name: "1 needs you" }).click();
		await expect.element(first.getByTestId("needs-you-item")).toBeVisible();
		expect(sessionStorage.getItem(EXPANDED_KEY)).toBe("1");
		first.unmount();

		// A later mount in the same browser session opens as the person left it.
		const second = mount(undefined, false);
		await expect.element(second.getByTestId("needs-you-item")).toBeVisible();
		await second.getByRole("button", { name: "1 needs you" }).click();
		expect(second.getByTestId("needs-you-item").elements()).toHaveLength(0);
		expect(sessionStorage.getItem(EXPANDED_KEY)).toBeNull();
		second.unmount();

		const third = mount(undefined, false);
		await expect
			.element(third.getByRole("button", { name: "1 needs you" }))
			.toHaveAttribute("aria-expanded", "false");
	});

	it("still starts collapsed when the browser will not give it storage", async () => {
		fake.pendingByDevice = { d1: { permissions: [permission()], questions: [] } };
		await browserPage.viewport(1200, 800);
		const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		try {
			const screen = mount(undefined, false);
			await expect
				.element(screen.getByRole("button", { name: "1 needs you" }))
				.toHaveAttribute("aria-expanded", "false");
		} finally {
			spy.mockRestore();
		}
	});
});

describe("NeedsYouInbox and the session open in the agent view", () => {
	it("leaves out the open session's ask, which the agent view already shows", async () => {
		fake.pendingByDevice = {
			d1: { permissions: [permission("a1", "perm-1")], questions: [question("a2", "que-1")] },
		};
		livePage.url = new URL("http://localhost:3000/code?device=d1&ws=w1&agent=a1");
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await expect.element(screen.getByTestId("needs-you-item")).toBeVisible();
		expect(screen.getByTestId("needs-you-item").elements()).toHaveLength(1);
		expect(inbox()?.textContent).toContain("Second");
		expect(inbox()?.textContent).not.toContain("Build it");
		await expect.element(screen.getByRole("button", { name: "1 needs you" })).toBeVisible();
	});

	it("draws no bar when the only pending asks belong to the open session", async () => {
		fake.pendingByDevice = { d1: { permissions: [permission("a1", "perm-1")], questions: [] } };
		livePage.url = new URL("http://localhost:3000/code?device=d1&ws=w1&agent=a1");
		await browserPage.viewport(1200, 800);
		mount();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(inbox()).toBeNull();
	});

	it("lists them again when the person opens another session", async () => {
		fake.pendingByDevice = { d1: { permissions: [permission("a1", "perm-1")], questions: [] } };
		livePage.url = new URL("http://localhost:3000/code?device=d1&ws=w1&agent=a1");
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(inbox()).toBeNull();

		livePage.url = new URL("http://localhost:3000/code?device=d1&ws=w1&agent=a9");
		flushSync();
		await expect.element(screen.getByTestId("needs-you-item")).toBeVisible();
		expect(inbox()?.textContent).toContain("Build it");
	});

	it("matches the device too: the same session id on another machine is still listed", async () => {
		fake.pendingByDevice = {
			d2: { permissions: [permission("a1", "perm-1")], questions: [] },
		};
		livePage.url = new URL("http://localhost:3000/code?device=d1&ws=w1&agent=a1");
		await browserPage.viewport(1200, 800);
		codeDeviceList.devices = [
			{ id: "d1", name: "Box", status: "paired", online: true },
			{ id: "d2", name: "Other", status: "paired", online: true },
		] as unknown as typeof codeDeviceList.devices;
		codeDeviceList.loading = false;
		sessionStorage.setItem(EXPANDED_KEY, "1");
		const screen = renderWithApp(NeedsYouInbox);
		await expect.element(screen.getByTestId("needs-you-item")).toBeVisible();
	});

	it("keeps answering converged: answering the listed ask clears the bar", async () => {
		fake.pendingByDevice = {
			d1: { permissions: [permission("a1", "perm-1")], questions: [question("a2", "que-1")] },
		};
		livePage.url = new URL("http://localhost:3000/code?device=d1&ws=w1&agent=a1");
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await expect.element(screen.getByTestId("needs-you-item")).toBeVisible();
		await screen.getByRole("button", { name: "Skip" }).click();
		await vi.waitFor(() => expect(inbox()).toBeNull());
	});
});
