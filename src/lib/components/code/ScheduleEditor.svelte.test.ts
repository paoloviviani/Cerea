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
		{ id: "d1", name: "Build box", status: "paired", online: true },
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
