/**
 * The project page's "Agent workspace" section (ADR 0106 §3): the user's own
 * default machine, workspace and permission word for sessions their chats in
 * this project start. The profile API and the /code client calls are fakes.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import ProjectAgentSection from "./ProjectAgentSection.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { resetCodeReauth } from "$lib/stores/codeReauth.svelte";
import type { ProjectAgentProfile } from "$lib/types/AgentSession";

const PROJECT = "691111111111111111111aaa";
const ROOT = `/api/v2/projects/${PROJECT}/agent-profile`;

const apiMock = vi.hoisted(() => ({
	listDevices: vi.fn(),
	listWorkspaces: vi.fn(),
	loadCodeStatus: vi.fn(async () => undefined),
	getSessionConnectors: vi.fn(),
}));
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	...apiMock,
}));

let stored: ProjectAgentProfile | null = null;
let calls: { method: string; body?: Record<string, unknown> }[] = [];
let putFailure: { status: number; message: string } | null = null;

const PROFILE: ProjectAgentProfile = {
	deviceId: "d1",
	workspaceId: "w1",
	permissionMode: "allow",
	modeId: "build",
	labels: { device: "Studio laptop", workspace: "cerea" },
	updatedAt: "2026-11-04T10:00:00.000Z",
};

function installFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
			if (!url.endsWith(ROOT)) return new Response("{}", { status: 404 });
			const method = init?.method ?? "GET";
			const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
			calls.push({ method, body });
			if (method === "PUT") {
				if (putFailure)
					return Response.json({ message: putFailure.message }, { status: putFailure.status });
				stored = {
					...(body as unknown as ProjectAgentProfile),
					labels: {
						device: "Studio laptop",
						workspace: body?.workspaceId === "w2" ? "docs" : "cerea",
					},
					updatedAt: "2026-11-04T11:00:00.000Z",
				};
				return Response.json(stored);
			}
			if (method === "DELETE") {
				stored = null;
				return new Response(null, { status: 204 });
			}
			return Response.json(stored);
		})
	);
}

function machines(list: Array<{ id: string; name: string; online?: boolean }>) {
	apiMock.listDevices.mockResolvedValue({
		devices: list.map((d) => ({ status: "paired", online: true, ...d })),
	});
}

const mount = () =>
	renderWithApp(ProjectAgentSection, { projectId: PROJECT }, { page: { data: {} } });

beforeEach(() => {
	stored = null;
	calls = [];
	putFailure = null;
	resetCodeReauth();
	codeDeviceList.devices = [];
	codeDeviceList.loading = true;
	codeDeviceList.fetchedAt = 0;
	apiMock.listDevices.mockReset();
	apiMock.listWorkspaces.mockReset().mockResolvedValue({
		workspaces: [
			{ id: "w1", name: "cerea", path: "/c", isGitRepo: true },
			{ id: "w2", name: "docs", path: "/d", isGitRepo: false },
		],
	});
	apiMock.getSessionConnectors.mockReset().mockResolvedValue({
		options: [{ key: "connector:a", name: "Tracker", kind: "connector", summary: "Issues" }],
		selected: [],
	});
	machines([{ id: "d1", name: "Studio laptop" }]);
	installFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe("ProjectAgentSection", () => {
	it("says it is personal, and explains what the permission word covers", async () => {
		const screen = mount();
		await expect
			.element(screen.getByText("Only you: other members of a shared project set their own."))
			.toBeVisible();
		await expect
			.element(screen.getByText(/A session that already exists keeps its own/))
			.toBeVisible();
	});

	it("hides itself when the API answers 404 (no /code for this user)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 404 }))
		);
		const screen = mount();
		await expect.element(screen.getByTestId("project-agent")).not.toBeVisible();
	});

	it("loads the saved profile into the pickers", async () => {
		stored = PROFILE;
		const screen = mount();
		await expect.element(screen.getByLabelText("Computer")).toHaveValue("d1");
		await expect.element(screen.getByLabelText("Workspace")).toHaveValue("w1");
		await expect
			.element(screen.getByRole("radio", { name: "Allow" }))
			.toHaveAttribute("aria-checked", "true");
		await expect.element(screen.getByRole("button", { name: "Remove" })).toBeVisible();
	});

	it("offers the connectors with none on, and saves the ones switched on as the default", async () => {
		const screen = mount();
		await screen.getByLabelText("Computer").selectOptions("d1");
		await expect.element(screen.getByRole("option", { name: "docs" })).toBeInTheDocument();
		await screen.getByLabelText("Workspace").selectOptions("w2");
		const tracker = screen.getByTestId("connector-switch-Tracker");
		await expect.element(tracker).not.toBeChecked();
		await screen.getByRole("button", { name: "Save" }).click();
		await expect.element(screen.getByText("Saved.")).toBeVisible();
		expect(calls.find((c) => c.method === "PUT")?.body).not.toHaveProperty("connectorKeys");
		await tracker.click();
		await expect.element(tracker).toBeChecked();
		await screen.getByRole("button", { name: "Save" }).click();
		await vi.waitFor(() =>
			expect(calls.filter((c) => c.method === "PUT")[1]?.body?.connectorKeys).toEqual([
				"connector:a",
			])
		);
	});

	it("saves a new target with Ask as the default permission", async () => {
		const screen = mount();
		await expect
			.element(screen.getByRole("radio", { name: "Ask" }))
			.toHaveAttribute("aria-checked", "true");
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		await screen.getByLabelText("Computer").selectOptions("d1");
		await expect.element(screen.getByRole("option", { name: "docs" })).toBeInTheDocument();
		await screen.getByLabelText("Workspace").selectOptions("w2");
		await screen.getByRole("button", { name: "Save" }).click();
		await expect.element(screen.getByText("Saved.")).toBeVisible();
		expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
			deviceId: "d1",
			workspaceId: "w2",
			permissionMode: "ask",
		});
	});

	it("offers Plan, Ask, Auto and Allow, and saves Auto as its own step (ADR 0109)", async () => {
		const screen = mount();
		const group = screen.getByRole("radiogroup", { name: "Permission" });
		await expect.element(group).toBeVisible();
		expect(
			group
				.getByRole("radio")
				.elements()
				.map((el) => el.textContent?.trim())
		).toEqual(["Plan", "Ask", "Auto", "Allow"]);
		await screen.getByLabelText("Computer").selectOptions("d1");
		await screen.getByLabelText("Workspace").selectOptions("w2");
		await screen.getByRole("radio", { name: "Auto" }).click();
		await screen.getByRole("button", { name: "Save" }).click();
		await expect.element(screen.getByText("Saved.")).toBeVisible();
		expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({
			permissionMode: "auto",
		});
	});

	it("changes the permission word and keeps the stored mode for the same machine", async () => {
		stored = PROFILE;
		const screen = mount();
		await expect.element(screen.getByLabelText("Workspace")).toHaveValue("w1");
		await screen.getByRole("radio", { name: "Plan" }).click();
		await screen.getByRole("button", { name: "Save" }).click();
		await expect.element(screen.getByText("Saved.")).toBeVisible();
		expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
			deviceId: "d1",
			workspaceId: "w1",
			permissionMode: "deny",
			modeId: "build",
		});
	});

	it("removes the profile and goes back to an empty form", async () => {
		stored = PROFILE;
		const screen = mount();
		await screen.getByRole("button", { name: "Remove" }).click();
		await expect.element(screen.getByText("Removed.")).toBeVisible();
		expect(calls.some((c) => c.method === "DELETE")).toBe(true);
		await expect.element(screen.getByLabelText("Computer")).toHaveValue("");
		await expect
			.element(screen.getByRole("radio", { name: "Ask" }))
			.toHaveAttribute("aria-checked", "true");
		expect(
			screen.baseElement.querySelector("button[type=button]:not([role=radio])")
		).not.toBeNull();
		await expect.element(screen.getByRole("button", { name: "Remove" })).not.toBeInTheDocument();
	});

	it("points at the Agents panel when no machine is paired", async () => {
		machines([]);
		const screen = mount();
		await expect.element(screen.getByTestId("project-agent-no-machines")).toBeVisible();
		await expect
			.element(screen.getByRole("link", { name: "Open the Agents panel" }))
			.toHaveAttribute("href", "/code");
		expect(screen.baseElement.querySelector("select")).toBeNull();
	});

	it("shows the API's reason when the save is refused, and keeps the choice", async () => {
		putFailure = { status: 400, message: "That workspace is not on this computer." };
		const screen = mount();
		await screen.getByLabelText("Computer").selectOptions("d1");
		await expect.element(screen.getByRole("option", { name: "docs" })).toBeInTheDocument();
		await screen.getByLabelText("Workspace").selectOptions("w2");
		await screen.getByRole("button", { name: "Save" }).click();
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("That workspace is not on this computer.");
		await expect.element(screen.getByLabelText("Workspace")).toHaveValue("w2");
		await expect.element(screen.getByText("Saved.")).not.toBeInTheDocument();
	});

	it("notes an offline machine and still shows the stored workspace by name", async () => {
		stored = PROFILE;
		machines([{ id: "d1", name: "Studio laptop", online: false }]);
		const screen = mount();
		await expect
			.element(screen.getByTestId("project-agent-note"))
			.toHaveTextContent("Studio laptop is offline");
		await expect.element(screen.getByLabelText("Workspace")).toHaveValue("w1");
		await expect.element(screen.getByRole("option", { name: "cerea" })).toBeInTheDocument();
		expect(apiMock.listWorkspaces).not.toHaveBeenCalled();
	});
});
