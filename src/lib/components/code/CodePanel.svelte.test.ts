import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import superjson from "superjson";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import CodePanel from "./CodePanel.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { codeReauth, flagCodeReauth, resetCodeReauth } from "$lib/stores/codeReauth.svelte";

/**
 * While the sign-in is older than 7 days the panel shows ONE card and nothing
 * the machines said. The server is the gate (it answers 401 to everything but
 * `/status`); this is what the page does with that: it asks `/status` first,
 * draws nothing from a machine while stale, and drops what it held the moment
 * any answer says so — or the freshUntil timer does, with no request.
 */
const calls = vi.hoisted(() => {
	const state = {
		listDevices: vi.fn(),
		listPendingApprovals: vi.fn(),
		getAgent: vi.fn(),
		status: {} as Record<string, unknown>,
		statusCalls: 0,
		/** The status body, serialized by the test (superjson lives there). */
		statusText: () => "",
	};
	// Installed before any import runs: the composer's MCP stores fetch at
	// module scope, and with the real `fetch` that reaches a SvelteKit server
	// this project has none of. Everything but `/status` gets an empty answer.
	const real = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (String(input).includes("/api/v2/code/status")) {
			state.statusCalls += 1;
			return new Response(state.statusText(), { status: 200 });
		}
		void real;
		return Response.json({});
	}) as typeof fetch;
	return state;
});

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listDevices: calls.listDevices,
	listPendingApprovals: calls.listPendingApprovals,
	getAgent: calls.getAgent,
	listWorkspaces: async () => ({ workspaces: [] }),
}));

let statusBody: Record<string, unknown>;
calls.statusText = () => superjson.stringify(statusBody);

function mount(url = "/code") {
	return renderWithApp(CodePanel, { enabled: true }, { page: { url } });
}

beforeEach(async () => {
	resetCodeReauth();
	// `loadCodeStatus` remembers it asked: force a fresh ask per test.
	calls.statusCalls = 0;
	calls.listDevices.mockReset();
	calls.listPendingApprovals.mockReset();
	calls.getAgent.mockReset();
	calls.listDevices.mockResolvedValue({
		devices: [{ id: "d1", name: "Secret Box", status: "paired" }],
	});
	calls.listPendingApprovals.mockResolvedValue({ permissions: [], questions: [] });
	codeDeviceList.devices = [];
	codeDeviceList.loading = true;
	statusBody = {
		enabled: true,
		fresh: false,
		reauthPath: "/login?reauth=1&next=/code",
	};
	await browserPage.viewport(1200, 800);
});

afterEach(() => {
	resetCodeReauth();
});

describe("CodePanel with a stale sign-in", () => {
	it("shows the one card with the exact words and a Sign in link to the path /status named", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("code-reauth-card")).toBeVisible();
		await expect
			.element(
				screen.getByText("Your sign-in is older than 7 days. Sign in again to see your machines.")
			)
			.toBeVisible();
		const link = screen.getByRole("link", { name: "Sign in" });
		await expect.element(link).toHaveAttribute("href", "/login?reauth=1&next=/code");
	});

	it("asks nothing of any machine: no device list, no inbox, no agent, no names", async () => {
		const screen = mount("/code?device=d1&ws=w1&agent=a1");
		await expect.element(screen.getByTestId("code-reauth-card")).toBeVisible();
		expect(calls.listDevices).not.toHaveBeenCalled();
		expect(calls.listPendingApprovals).not.toHaveBeenCalled();
		expect(calls.getAgent).not.toHaveBeenCalled();
		expect(screen.getByTestId("needs-you-inbox").elements()).toHaveLength(0);
		expect(document.body.textContent).not.toContain("Secret Box");
		expect(document.body.textContent).not.toContain("Open Agents panel");
	});

	it("waits for /status instead of firing requests the server would refuse", async () => {
		const screen = mount();
		void screen;
		await vi.waitFor(() => expect(calls.statusCalls).toBeGreaterThanOrEqual(1));
		expect(calls.listDevices).not.toHaveBeenCalled();
		// Let the answer land before the test ends, or it applies in the next one.
		await expect.element(screen.getByTestId("code-reauth-card")).toBeVisible();
	});
});

describe("CodePanel with a fresh sign-in", () => {
	beforeEach(() => {
		statusBody = {
			enabled: true,
			fresh: true,
			reauthPath: "/login?reauth=1&next=/code",
			freshUntil: new Date(Date.now() + 3_600_000).toISOString(),
		};
	});

	it("draws the panel, and drops everything the moment any call says it went stale", async () => {
		const screen = mount();
		await expect.element(screen.getByText("No agent selected")).toBeVisible();
		expect(screen.getByTestId("code-reauth-card").elements()).toHaveLength(0);
		expect(codeDeviceList.devices.length).toBeGreaterThan(0);

		flagCodeReauth();
		await expect.element(screen.getByTestId("code-reauth-card")).toBeVisible();
		expect(codeDeviceList.devices).toEqual([]);
		expect(screen.getByText("No agent selected").elements()).toHaveLength(0);
	});

	it("flips to the card when freshUntil passes, with no request needed", async () => {
		statusBody = {
			...statusBody,
			freshUntil: new Date(Date.now() + 400).toISOString(),
		};
		const screen = mount();
		await expect.element(screen.getByText("No agent selected")).toBeVisible();
		const before = calls.listDevices.mock.calls.length;
		await expect.element(screen.getByTestId("code-reauth-card")).toBeVisible();
		// Nothing was asked of the server to find out.
		expect(codeReauth.required).toBe(true);
		expect(calls.statusCalls).toBe(1);
		expect(calls.listDevices.mock.calls.length).toBe(before);
	});
});
