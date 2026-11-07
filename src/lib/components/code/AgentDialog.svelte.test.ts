import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentDialog from "./AgentDialog.svelte";

const api = vi.hoisted(() => ({
	listProviders: vi.fn(),
	createAgent: vi.fn(),
	setPermissionMode: vi.fn(),
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	...api,
}));

const workspace = { id: "w1", path: "/home/me/project", name: "project" } as never;

function mount(oncreated: () => void = () => {}) {
	return renderWithApp(AgentDialog, {
		deviceId: "d1",
		workspace,
		onclose: () => {},
		oncreated,
	});
}

describe("AgentDialog backend choice", () => {
	beforeEach(() => {
		api.listProviders.mockReset();
		api.createAgent.mockReset();
	});

	it("names the machine's one backend instead of offering a one-item list", async () => {
		api.listProviders.mockResolvedValue({ providers: [{ id: "opencode", available: true }] });
		const screen = mount();
		await expect.element(screen.getByTestId("agent-backend")).toHaveTextContent("Runs on opencode");
		expect(screen.getByLabelText("Provider").elements()).toHaveLength(0);
	});

	it("offers the choice when the machine runs more than one backend", async () => {
		api.listProviders.mockResolvedValue({
			providers: [
				{ id: "opencode", available: true },
				{ id: "acp:claude", available: true },
			],
		});
		const screen = mount();
		await expect.element(screen.getByLabelText("Provider")).toBeVisible();
		expect(screen.getByTestId("agent-backend").elements()).toHaveLength(0);
	});
});

describe("AgentDialog new session", () => {
	beforeEach(() => {
		api.listProviders.mockReset();
		api.createAgent.mockReset();
		api.setPermissionMode.mockReset();
		api.listProviders.mockResolvedValue({ providers: [{ id: "opencode", available: true }] });
		api.createAgent.mockResolvedValue({ agent: { id: "a1" } });
		api.setPermissionMode.mockResolvedValue({ ok: true });
	});

	it("says session, not agent", async () => {
		const screen = mount();
		await expect.element(screen.getByRole("heading", { name: "New session" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Start session" })).toBeVisible();
		expect(document.body.textContent).not.toMatch(/New agent|Create agent/);
	});

	it("offers Plan, Ask, Auto and Allow", async () => {
		const screen = mount();
		for (const name of ["Plan", "Ask", "Auto", "Allow"]) {
			await expect.element(screen.getByRole("button", { name, exact: true })).toBeVisible();
		}
	});

	it("starts an Ask session on the build agent without touching its permission word", async () => {
		const screen = mount();
		await screen.getByRole("button", { name: "Ask", exact: true }).click();
		await screen.getByRole("button", { name: "Start session" }).click();
		await vi.waitFor(() => expect(api.createAgent).toHaveBeenCalled());
		expect(api.createAgent.mock.calls[0][1]).toMatchObject({ posture: "build" });
		expect(api.setPermissionMode).not.toHaveBeenCalled();
	});

	it("sets Auto and Allow on the new session", async () => {
		const onCreated = vi.fn();
		const screen = mount(onCreated);
		await screen.getByRole("button", { name: "Auto", exact: true }).click();
		await screen.getByRole("button", { name: "Start session" }).click();
		await vi.waitFor(() => expect(onCreated).toHaveBeenCalled());
		expect(api.setPermissionMode).toHaveBeenCalledWith("d1", "a1", "ask", { auto: true });
	});
});
