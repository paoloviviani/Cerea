import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import ScheduleEditor from "./ScheduleEditor.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";

const api = vi.hoisted(() => ({
	listWorkspaces: vi.fn(),
	listWorkspaceAgents: vi.fn(),
	listProviders: vi.fn(),
	listProviderModes: vi.fn(),
	listProviderModels: vi.fn(),
	previewRecurrence: vi.fn(),
	suggestWorkspaceDirectories: vi.fn(),
	createWorkspace: vi.fn(),
	createSchedule: vi.fn(),
	updateSchedule: vi.fn(),
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	...api,
}));

const session = (id: string, title: string) => ({
	id,
	workspaceId: "w1",
	title,
	provider: "opencode",
	state: "idle",
	updatedAt: "2026-10-08T00:00:00Z",
	modeId: null,
	modelId: null,
	parentId: null,
});

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockReset();
	codeDeviceList.devices = [
		{
			id: "d1",
			name: "Build box",
			status: "paired",
			online: true,
			backends: [{ id: "opencode", version: "1.18.34", capabilities: { coordinationGrant: true } }],
			policy: { workspaceRoots: [], allowFreeModels: false },
		},
		{ id: "d2", name: "Laptop", status: "paired", online: false },
	] as never;
	codeDeviceList.loading = false;
	api.listWorkspaces.mockResolvedValue({
		workspaces: [{ id: "w1", name: "repo", path: "/repo", isGitRepo: true }],
	});
	api.listWorkspaceAgents.mockResolvedValue({
		agents: [session("s1", "Fix flaky test"), session("s2", "Docs pass")],
	});
	api.listProviders.mockResolvedValue({
		providers: [{ id: "opencode", available: true, enrollmentExpired: false }],
	});
	api.listProviderModes.mockResolvedValue({
		modes: [
			{ id: "plan", label: "Plan" },
			{ id: "build", label: "Build" },
		],
	});
	api.listProviderModels.mockResolvedValue({
		models: [{ id: "pystino/m", label: "Mock model" }],
	});
	api.previewRecurrence.mockResolvedValue({
		ok: true,
		description: "Every day at 09:00",
		next: [
			new Date("2026-10-09T07:00:00Z"),
			new Date("2026-10-10T07:00:00Z"),
			new Date("2026-10-11T07:00:00Z"),
		],
	});
	api.suggestWorkspaceDirectories.mockResolvedValue({ directories: [] });
	api.createSchedule.mockImplementation(async (input) => ({
		schedule: { id: "sch1", ...input, targetLabel: "" },
	}));
	api.createWorkspace.mockResolvedValue({
		workspace: { id: "w-new", name: "fresh", path: "/work/fresh", isGitRepo: false },
	});
});

function mount(props: Record<string, unknown> = {}) {
	const onsaved = vi.fn();
	const oncancel = vi.fn();
	const screen = renderWithApp(ScheduleEditor, { onsaved, oncancel, ...props });
	return { screen, onsaved, oncancel };
}

describe("ScheduleEditor permission mode", () => {
	it("says unattended Ask stalls, and where the approval shows up, next to the selector", async () => {
		const { screen } = mount();
		const warning = screen.getByTestId("ask-warning");
		await expect.element(warning).toBeVisible();
		await expect.element(warning).toHaveTextContent("Needs-you inbox");
		await expect
			.element(screen.getByRole("radio", { name: "Ask" }))
			.toHaveAttribute("aria-checked", "true");

		await screen.getByRole("radio", { name: "Allow" }).click();
		expect(screen.getByTestId("ask-warning").elements()).toHaveLength(0);
		await expect.element(screen.getByText(/never past the machine's own ceiling/)).toBeVisible();
	});
});

describe("ScheduleEditor target picker", () => {
	it("lists the machines with online/offline, then that machine's workspaces and sessions", async () => {
		const { screen } = mount();
		const machine = screen.getByLabelText("1. Machine");
		await expect
			.element(machine.getByRole("option", { name: "Build box · online" }))
			.toBeInTheDocument();
		await expect
			.element(machine.getByRole("option", { name: "Laptop · offline" }))
			.toBeInTheDocument();

		await machine.selectOptions("d1");
		const workspace = screen.getByLabelText("2. Workspace");
		await expect.element(workspace.getByRole("option", { name: "repo" })).toBeInTheDocument();
		await expect
			.element(workspace.getByRole("option", { name: "New workspace…" }))
			.toBeInTheDocument();

		await workspace.selectOptions("w1");
		const sessions = screen.getByLabelText("3. Session");
		await expect
			.element(sessions.getByRole("option", { name: "A new session each run" }))
			.toBeInTheDocument();
		await expect
			.element(sessions.getByRole("option", { name: "Fix flaky test" }))
			.toBeInTheDocument();
		expect(api.listWorkspaceAgents).toHaveBeenCalledWith("d1", "w1");
	});

	it("lets an offline machine be chosen, says what will happen, and offers no new workspace", async () => {
		const { screen } = mount();
		await screen.getByLabelText("1. Machine").selectOptions("d2");
		await expect.element(screen.getByTestId("machine-offline-note")).toHaveTextContent("offline");
		await expect.element(screen.getByTestId("machine-offline-note")).toHaveTextContent("missed");
		expect(api.listWorkspaces).not.toHaveBeenCalled();
		expect(
			screen
				.getByLabelText("2. Workspace")
				.getByRole("option", { name: "New workspace…" })
				.elements()
		).toHaveLength(0);
	});

	it("prefills machine, workspace and session from a session's menu", async () => {
		const { screen, onsaved } = mount({
			prefill: { deviceId: "d1", workspaceId: "w1", sessionId: "s2" },
		});
		await expect.element(screen.getByLabelText("2. Workspace")).toHaveValue("w1");
		await expect.element(screen.getByLabelText("3. Session")).toHaveValue("s2");

		await screen.getByLabelText("Name").fill("Docs nightly");
		await screen.getByLabelText("Prompt").fill("tidy the docs");
		await screen.getByRole("button", { name: "Create schedule" }).click();
		await vi.waitFor(() => expect(onsaved).toHaveBeenCalled());
		expect(api.createSchedule.mock.calls[0][0]).toMatchObject({
			name: "Docs nightly",
			prompt: "tidy the docs",
			target: {
				deviceId: "d1",
				workspaceId: "w1",
				sessionMode: "existing",
				sessionId: "s2",
				permissionMode: "ask",
				labels: { workspace: "repo", session: "Docs pass" },
			},
		});
	});

	it("sends 'a new session each run' with no session id", async () => {
		const { screen, onsaved } = mount({ prefill: { deviceId: "d1", workspaceId: "w1" } });
		await expect.element(screen.getByLabelText("3. Session")).toHaveValue("__new__");
		await screen.getByLabelText("Name").fill("Nightly");
		await screen.getByLabelText("Prompt").fill("go");
		await screen.getByRole("radio", { name: "Allow" }).click();
		await screen.getByRole("button", { name: "Create schedule" }).click();
		await vi.waitFor(() => expect(onsaved).toHaveBeenCalled());
		const target = api.createSchedule.mock.calls[0][0].target;
		expect(target).toMatchObject({ sessionMode: "new", permissionMode: "allow" });
		expect(target).not.toHaveProperty("sessionId");
	});
});

describe("ScheduleEditor new workspace", () => {
	async function fillNewWorkspace(screen: ReturnType<typeof mount>["screen"]) {
		await screen.getByLabelText("1. Machine").selectOptions("d1");
		await expect
			.element(screen.getByLabelText("2. Workspace").getByRole("option", { name: "repo" }))
			.toBeInTheDocument();
		await screen.getByLabelText("2. Workspace").selectOptions("__new__");
		await screen.getByLabelText("Name").fill("Fresh");
		await screen.getByLabelText("Prompt").fill("build it");
		await screen.getByLabelText("Directory on the machine").fill("/work/fresh");
		await screen.getByLabelText("Title (optional)").fill("fresh");
	}

	it("creates the workspace on save, then points the schedule at it", async () => {
		const { screen, onsaved } = mount();
		await fillNewWorkspace(screen);
		expect(api.createWorkspace).not.toHaveBeenCalled();
		await screen.getByRole("button", { name: "Create schedule" }).click();
		await vi.waitFor(() => expect(onsaved).toHaveBeenCalled());
		expect(api.createWorkspace).toHaveBeenCalledWith("d1", { path: "/work/fresh", title: "fresh" });
		expect(api.createSchedule.mock.calls[0][0].target).toMatchObject({
			workspaceId: "w-new",
			sessionMode: "new",
			labels: { workspace: "fresh" },
		});
		expect(api.createWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
			api.createSchedule.mock.invocationCallOrder[0]
		);
	});

	it("shows the machine's refusal inline and saves nothing", async () => {
		api.createWorkspace.mockRejectedValue(
			new Error("that directory is outside the workspace roots")
		);
		const { screen, onsaved } = mount();
		await fillNewWorkspace(screen);
		await screen.getByRole("button", { name: "Create schedule" }).click();
		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("outside the workspace roots");
		expect(api.createSchedule).not.toHaveBeenCalled();
		expect(onsaved).not.toHaveBeenCalled();
	});

	it("keeps a workspace it made when the schedule then fails, so a retry makes no second one", async () => {
		api.createSchedule.mockRejectedValueOnce(new Error("You can have at most 20 schedules."));
		const { screen, onsaved } = mount();
		await fillNewWorkspace(screen);
		await screen.getByRole("button", { name: "Create schedule" }).click();
		await expect.element(screen.getByRole("alert")).toHaveTextContent("at most 20");
		await screen.getByRole("button", { name: "Create schedule" }).click();
		await vi.waitFor(() => expect(onsaved).toHaveBeenCalled());
		expect(api.createWorkspace).toHaveBeenCalledTimes(1);
		expect(api.createSchedule.mock.calls[1][0].target.workspaceId).toBe("w-new");
	});
});

describe("ScheduleEditor timetable", () => {
	it("previews the next three runs, and shows why a recurrence is refused", async () => {
		const { screen } = mount();
		await expect.element(screen.getByTestId("schedule-preview")).toHaveTextContent("Next runs");
		await vi.waitFor(() =>
			expect(screen.getByTestId("schedule-preview").element().querySelectorAll("li")).toHaveLength(
				3
			)
		);

		api.previewRecurrence.mockResolvedValue({
			ok: false,
			error: "Runs must be at least 15 minutes apart; that expression fires sooner.",
		});
		await screen.getByLabelText("Repeats").selectOptions("cron");
		await screen.getByLabelText("Cron expression").fill("*/5 * * * *");
		await expect.element(screen.getByTestId("preview-error")).toHaveTextContent("15 minutes");
		expect(api.previewRecurrence).toHaveBeenLastCalledWith(
			{ type: "cron", expr: "*/5 * * * *" },
			expect.any(String)
		);
	});

	it("sends the preset the person picked, in the zone they typed", async () => {
		const { screen, onsaved } = mount({ prefill: { deviceId: "d1", workspaceId: "w1" } });
		await expect.element(screen.getByLabelText("2. Workspace")).toHaveValue("w1");
		await screen.getByLabelText("Name").fill("Weekly");
		await screen.getByLabelText("Prompt").fill("go");
		await screen.getByLabelText("Repeats").selectOptions("weekly");
		await screen.getByLabelText("On", { exact: true }).selectOptions("3");
		await screen.getByLabelText("Timezone").fill("Europe/Rome");
		await screen.getByRole("button", { name: "Create schedule" }).click();
		await vi.waitFor(() => expect(onsaved).toHaveBeenCalled());
		expect(api.createSchedule.mock.calls[0][0]).toMatchObject({
			recurrence: { type: "weekly", day: 3, at: "09:00" },
			timezone: "Europe/Rome",
		});
	});
});

describe("ScheduleEditor coordination options", () => {
	const device = (over: Record<string, unknown> = {}) =>
		({
			id: "d1",
			name: "Build box",
			status: "paired",
			online: true,
			backends: [{ id: "opencode", version: "1.18.34", capabilities: { coordinationGrant: true } }],
			policy: { workspaceRoots: [], allowFreeModels: false },
			...over,
		}) as never;
	const message = "Can find, read and message other sessions";
	const spawn = "Can start new sessions";

	async function fillAndSave(screen: ReturnType<typeof mount>["screen"], onsaved: unknown) {
		await screen.getByLabelText("Name").fill("Orchestrate");
		await screen.getByLabelText("Prompt").fill("check on the other sessions");
		await screen.getByRole("button", { name: "Create schedule" }).click();
		await vi.waitFor(() => expect(onsaved).toHaveBeenCalled());
		return api.createSchedule.mock.calls[0][0].target;
	}

	it("offers both options, off, and saves a target with neither", async () => {
		const { screen, onsaved } = mount({ prefill: { deviceId: "d1", workspaceId: "w1" } });
		await expect.element(screen.getByLabelText(message)).not.toBeChecked();
		await expect.element(screen.getByLabelText(spawn)).not.toBeChecked();
		const target = await fillAndSave(screen, onsaved);
		expect(target).not.toHaveProperty("canMessage");
		expect(target).not.toHaveProperty("canSpawn");
	});

	it("saves each option when it is ticked", async () => {
		const { screen, onsaved } = mount({ prefill: { deviceId: "d1", workspaceId: "w1" } });
		await screen.getByLabelText(message).click();
		await screen.getByLabelText(spawn).click();
		const target = await fillAndSave(screen, onsaved);
		expect(target).toMatchObject({ canMessage: true, canSpawn: true });
	});

	it("shows a saved schedule's options as they were saved", async () => {
		const { screen } = mount({
			editing: {
				id: "sch1",
				name: "Orchestrate",
				prompt: "p",
				enabled: true,
				timezone: "UTC",
				recurrence: { type: "daily", at: "09:00" },
				target: {
					deviceId: "d1",
					workspaceId: "w1",
					sessionMode: "new",
					permissionMode: "ask",
					canSpawn: true,
				},
			},
		});
		await expect.element(screen.getByLabelText(message)).not.toBeChecked();
		await expect.element(screen.getByLabelText(spawn)).toBeChecked();
	});

	it("warns, with the run row's words, when the machine's galopin cannot grant them", async () => {
		codeDeviceList.devices = [
			device({ backends: [{ id: "opencode", version: "1.18.31", capabilities: {} }] }),
		];
		const { screen } = mount({ prefill: { deviceId: "d1", workspaceId: "w1" } });
		const warning = screen.getByTestId("coordination-unsupported");
		await expect.element(warning).toBeVisible();
		await expect
			.element(warning)
			.toHaveTextContent("galopin is too old to grant coordination; update it");
	});

	it("says agent tools are off, instead of too old, for a machine enrolled without them", async () => {
		codeDeviceList.devices = [
			device({ policy: { workspaceRoots: [], allowFreeModels: false, agentTools: "denied" } }),
		];
		const { screen } = mount({ prefill: { deviceId: "d1", workspaceId: "w1" } });
		await expect
			.element(screen.getByTestId("coordination-unsupported"))
			.toHaveTextContent("enrolled without agent tools");
	});

	it("is quiet for a machine that can grant them and caps nothing", async () => {
		const { screen } = mount({ prefill: { deviceId: "d1", workspaceId: "w1" } });
		await screen.getByLabelText(message).click();
		expect(screen.getByTestId("coordination-unsupported").elements()).toHaveLength(0);
		expect(screen.getByTestId("coordination-ceiling").elements()).toHaveLength(0);
	});

	it("says what the machine's ceiling still holds at Ask, only for what is ticked", async () => {
		codeDeviceList.devices = [
			device({
				policy: {
					workspaceRoots: [],
					allowFreeModels: false,
					permission: { max: { session_send: "ask", session_spawn: "ask" } },
				},
			}),
		];
		const { screen } = mount({ prefill: { deviceId: "d1", workspaceId: "w1" } });
		expect(screen.getByTestId("coordination-ceiling").elements()).toHaveLength(0);
		await screen.getByLabelText(message).click();
		const note = screen.getByTestId("coordination-ceiling");
		await expect.element(note).toHaveTextContent("messaging sessions at Ask");
		await expect.element(note).toHaveTextContent("Needs-you inbox");
		await expect.element(note).not.toHaveTextContent("starting sessions");
		await screen.getByLabelText(spawn).click();
		await expect
			.element(screen.getByTestId("coordination-ceiling"))
			.toHaveTextContent("messaging and starting sessions at Ask");
	});
});
