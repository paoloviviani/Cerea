/**
 * The session card a conversation keeps for `agent_start` / `agent_send`
 * (ADR 0106 §4): rendered from the stored update, live state from the /code
 * client data. The machine side is a fake; what is under test is which state
 * and which line the card draws, and where the link goes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentSessionCard from "./AgentSessionCard.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { clearCodePanelCache } from "$lib/stores/codeTreeCache.svelte";
import { resetCodeReauth, flagCodeReauth } from "$lib/stores/codeReauth.svelte";
import { MessageUpdateType, type MessageAgentSessionUpdate } from "$lib/types/MessageUpdate";

const apiMock = vi.hoisted(() => ({
	listDevices: vi.fn(),
	listWorkspaces: vi.fn(),
	listAgents: vi.fn(),
	loadCodeStatus: vi.fn(async () => undefined),
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	...apiMock,
}));

function update(over: Partial<MessageAgentSessionUpdate> = {}): MessageAgentSessionUpdate {
	return {
		type: MessageUpdateType.AgentSession,
		action: "started",
		deviceId: "d1",
		workspaceId: "w1",
		sessionId: "ses 1",
		title: "Fix the flaky login test",
		labels: { device: "Studio laptop", workspace: "cerea" },
		...over,
	};
}

function session(state: string) {
	return {
		id: "ses 1",
		workspaceId: "w1",
		title: "Fix the flaky login test",
		provider: "opencode",
		state,
		updatedAt: "2026-11-04T10:00:00Z",
		modeId: null,
		modelId: null,
	};
}

function machine(online = true) {
	apiMock.listDevices.mockResolvedValue({
		devices: [{ id: "d1", name: "Studio laptop", status: "paired", online }],
	});
}

function mount(over: Partial<MessageAgentSessionUpdate> = {}, enabled = true) {
	return renderWithApp(
		AgentSessionCard,
		{ update: update(over) },
		{ page: { data: { codeAgentsEnabled: enabled } } }
	);
}

beforeEach(() => {
	clearCodePanelCache();
	resetCodeReauth();
	codeDeviceList.devices = [];
	codeDeviceList.loading = true;
	codeDeviceList.fetchedAt = 0;
	apiMock.listDevices.mockReset();
	apiMock.listWorkspaces.mockReset().mockResolvedValue({ workspaces: [] });
	apiMock.listAgents.mockReset().mockResolvedValue({ agents: [session("idle")] });
});

describe("AgentSessionCard", () => {
	it("names the session, the machine and workspace, and links to it in /code", async () => {
		machine();
		const screen = mount();
		await expect.element(screen.getByText("Fix the flaky login test")).toBeVisible();
		await expect
			.element(screen.getByTestId("agent-session-route"))
			.toHaveTextContent("Started · Studio laptop › cerea");
		const link = screen.getByRole("link", { name: "Open Fix the flaky login test in /code" });
		await expect.element(link).toHaveAttribute("href", "/code?device=d1&ws=w1&agent=ses%201");
		await expect.element(screen.getByRole("link")).toHaveTextContent("Open in /code");
	});

	it("says prompted for a message sent to an existing session", async () => {
		machine();
		const screen = mount({ action: "prompted" });
		await expect
			.element(screen.getByTestId("agent-session-route"))
			.toHaveTextContent("Prompted · Studio laptop › cerea");
	});

	it.each([
		["running", "working", "Working"],
		["waiting-permission", "needs-you", "Needs you"],
		["error", "error", "Failed"],
		["idle", "idle", "Idle"],
	])("shows the live state: session %s reads %s", async (turn, state, label) => {
		machine();
		apiMock.listAgents.mockResolvedValue({ agents: [session(turn)] });
		const screen = mount();
		await expect.element(screen.getByTestId("agent-session-state")).toHaveTextContent(label);
		await expect
			.element(screen.getByTestId("agent-session-card"))
			.toHaveAttribute("data-state", state);
	});

	it("shows a plain offline line when the machine is offline", async () => {
		machine(false);
		const screen = mount();
		await expect.element(screen.getByTestId("agent-session-state")).toHaveTextContent("Offline");
		await expect
			.element(screen.getByTestId("agent-session-offline"))
			.toHaveTextContent("Studio laptop is offline.");
		// The record still reads, and the session is still where it was.
		await expect.element(screen.getByText("Fix the flaky login test")).toBeVisible();
		expect(apiMock.listAgents).not.toHaveBeenCalled();
	});

	it("says so when the session is no longer on the machine", async () => {
		machine();
		apiMock.listAgents.mockResolvedValue({ agents: [] });
		const screen = mount();
		await expect
			.element(screen.getByTestId("agent-session-state"))
			.toHaveTextContent("No longer on this machine");
	});

	it("shows the compact sign-in card instead of a state when the sign-in is stale", async () => {
		machine();
		flagCodeReauth();
		const screen = mount();
		await expect.element(screen.getByTestId("code-reauth-card")).toBeVisible();
		expect(screen.baseElement.querySelector('[data-testid="agent-session-state"]')).toBeNull();
		expect(screen.baseElement.querySelector("a[href*='/code?device']")).toBeNull();
		expect(apiMock.listAgents).not.toHaveBeenCalled();
	});

	it("is the record only, with no state and no link, where /code is not enabled", async () => {
		machine();
		const screen = mount({}, false);
		await expect.element(screen.getByText("Fix the flaky login test")).toBeVisible();
		expect(screen.baseElement.querySelector('[data-testid="agent-session-state"]')).toBeNull();
		expect(screen.baseElement.querySelector("a")).toBeNull();
		expect(apiMock.listDevices).not.toHaveBeenCalled();
	});

	it("is a labelled region, so a screen reader can find the session", async () => {
		machine();
		const screen = mount();
		await expect
			.element(screen.getByRole("region", { name: "Coding session: Fix the flaky login test" }))
			.toBeVisible();
	});
});
