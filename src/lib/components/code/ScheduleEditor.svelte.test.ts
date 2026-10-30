import { describe, it, expect, vi, beforeEach } from "vitest";
import superjson from "superjson";
import { renderWithApp, setPage } from "$lib/components/__tests__/renderWithApp";
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

		await screen.getByLabelText("Name", { exact: true }).fill("Docs nightly");
		await screen.getByLabelText("Prompt", { exact: true }).fill("tidy the docs");
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
		await screen.getByLabelText("Name", { exact: true }).fill("Nightly");
		await screen.getByLabelText("Prompt", { exact: true }).fill("go");
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
		await screen.getByLabelText("Name", { exact: true }).fill("Fresh");
		await screen.getByLabelText("Prompt", { exact: true }).fill("build it");
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

		// Refuse only the typed expression. Answering every call with the refusal
		// let the debounced preview of the cron default, fired when "cron" is
		// picked, put the error up before the typed expression was ever sent, so
		// the call assertion below raced the 250 ms debounce.
		const accepted = await api.previewRecurrence({ type: "daily", at: "09:00" }, "UTC");
		api.previewRecurrence.mockClear();
		api.previewRecurrence.mockImplementation(async (rec: { expr?: string }) =>
			rec.expr === "*/5 * * * *"
				? {
						ok: false as const,
						error: "Runs must be at least 15 minutes apart; that expression fires sooner.",
					}
				: accepted
		);
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
		await screen.getByLabelText("Name", { exact: true }).fill("Weekly");
		await screen.getByLabelText("Prompt", { exact: true }).fill("go");
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

describe("ScheduleEditor stopping criterion", () => {
	const editingRow = {
		id: "sch1",
		name: "Twice",
		prompt: "p",
		enabled: true,
		timezone: "UTC",
		recurrence: { type: "daily", at: "09:00" },
		target: { deviceId: "d1", workspaceId: "w1", sessionMode: "new", permissionMode: "ask" },
	};

	async function fillAndSave(screen: ReturnType<typeof mount>["screen"], onsaved: unknown) {
		await screen.getByLabelText("Name", { exact: true }).fill("Twice");
		await screen.getByLabelText("Prompt", { exact: true }).fill("go");
		await screen.getByRole("button", { name: "Create schedule" }).click();
		await vi.waitFor(() => expect(onsaved).toHaveBeenCalled());
		const calls = api.createSchedule.mock.calls;
		return calls[calls.length - 1][0];
	}

	it("sends the cap when the field is filled, and null when it is empty", async () => {
		const { screen, onsaved } = mount({ prefill: { deviceId: "d1", workspaceId: "w1" } });
		await screen.getByLabelText("Stop after (runs)").fill("5");
		const sent = await fillAndSave(screen, onsaved);
		expect(sent.maxOccurrences).toBe(5);
		screen.unmount();

		const empty = mount({ prefill: { deviceId: "d1", workspaceId: "w1" } });
		const sentEmpty = await fillAndSave(empty.screen, empty.onsaved);
		expect(sentEmpty.maxOccurrences).toBeNull();
	});

	it("prefills from the schedule being edited, and clears when emptied", async () => {
		api.updateSchedule.mockResolvedValue({ schedule: { id: "sch1" } });
		const { screen, onsaved } = mount({ editing: { ...editingRow, maxOccurrences: 7 } });
		await expect.element(screen.getByLabelText("Stop after (runs)")).toHaveValue(7);
		await screen.getByLabelText("Stop after (runs)").fill("");
		await screen.getByRole("button", { name: "Save changes" }).click();
		await vi.waitFor(() => expect(onsaved).toHaveBeenCalled());
		expect(api.updateSchedule.mock.calls[0][1].maxOccurrences).toBeNull();
	});

	it("sends nothing when the cap is below 1: the field itself refuses it", async () => {
		const { screen, onsaved } = mount({ prefill: { deviceId: "d1", workspaceId: "w1" } });
		await screen.getByLabelText("Name", { exact: true }).fill("Twice");
		await screen.getByLabelText("Prompt", { exact: true }).fill("go");
		await screen.getByLabelText("Stop after (runs)").fill("0");
		await screen.getByRole("button", { name: "Create schedule" }).click();
		expect(api.createSchedule).not.toHaveBeenCalled();
		expect(onsaved).not.toHaveBeenCalled();
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
		await screen.getByLabelText("Name", { exact: true }).fill("Orchestrate");
		await screen.getByLabelText("Prompt", { exact: true }).fill("check on the other sessions");
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

	it("says an agent made the schedule, linking its session; a person's says nothing", async () => {
		const base = {
			id: "sch1",
			name: "Check CI",
			prompt: "p",
			enabled: true,
			timezone: "UTC",
			recurrence: { type: "daily", at: "09:00" },
			target: { deviceId: "d1", workspaceId: "w1", sessionMode: "new", permissionMode: "ask" },
		};
		const { screen } = mount({
			editing: {
				...base,
				createdBy: {
					kind: "agent",
					deviceId: "d1",
					workspaceId: "w1",
					sessionId: "ses_42",
					title: "Refactor the parser",
				},
			},
		});
		const tag = screen.getByTestId("schedule-created-by");
		await expect.element(tag).toHaveTextContent("Created by an agent in Refactor the parser");
		await expect
			.element(tag.getByRole("link", { name: "Refactor the parser" }))
			.toHaveAttribute("href", "/code?device=d1&ws=w1&agent=ses_42");
		screen.unmount();

		const person = mount({ editing: base });
		await expect
			.element(person.screen.getByLabelText("Name", { exact: true }))
			.toHaveValue("Check CI");
		expect(person.screen.getByTestId("schedule-created-by").elements()).toHaveLength(0);
	});
});

describe("ScheduleEditor for a chat", () => {
	beforeEach(() => {
		setPage({
			data: {
				codeSchedulesEnabled: false,
				conversations: [
					{ id: "c1", title: "Weekly notes" },
					{ id: "c2", title: "Trip planning" },
				],
				models: [
					{ id: "m1", displayName: "Fast model" },
					{ id: "m2", displayName: "Big model" },
				],
			},
		});
	});

	it("opens from a conversation on continuing that chat, with no machine to choose", async () => {
		const { screen } = mount({ prefill: { conversationId: "c1" } });

		await expect.element(screen.getByLabelText("Chat", { exact: true })).toHaveValue("c1");
		expect(screen.getByLabelText("1. Machine").elements()).toHaveLength(0);
		await expect
			.element(screen.getByTestId("chat-unattended-hint"))
			.toHaveTextContent("cannot run Python");
	});

	it("saves a chat schedule with its mode and target, the default being the same chat", async () => {
		const { screen, onsaved } = mount({ prefill: { conversationId: "c1" } });
		await screen.getByLabelText("Name", { exact: true }).fill("Weekly news");
		await screen.getByLabelText("Prompt", { exact: true }).fill("Summarise the news on X");
		await screen.getByRole("button", { name: "Create schedule" }).click();

		expect(api.createSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "chat",
				name: "Weekly news",
				prompt: "Summarise the news on X",
				target: { mode: "continue", conversationId: "c1", permissionMode: "ask" },
			})
		);
		await vi.waitFor(() => expect(onsaved).toHaveBeenCalled());
	});

	it("starts a new chat each time with the model of the chat it was opened from", async () => {
		const { screen } = mount({ prefill: { conversationId: "c2" } });
		await screen.getByLabelText("Chat", { exact: true }).selectOptions("__new__");
		await expect
			.element(screen.getByText(/same model and project as “Trip planning”/))
			.toBeVisible();
		await screen.getByLabelText("Name", { exact: true }).fill("Trips");
		await screen.getByLabelText("Prompt", { exact: true }).fill("Any new ideas?");
		await screen.getByRole("button", { name: "Create schedule" }).click();

		expect(api.createSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "chat",
				target: { mode: "new", conversationId: "c2", permissionMode: "ask" },
			})
		);
	});

	it("asks for a model when opened from the list, and for a chat to continue", async () => {
		const { screen } = mount();
		await screen.getByLabelText("Name", { exact: true }).fill("Digest");
		await screen.getByLabelText("Prompt", { exact: true }).fill("Digest please");
		await screen.getByRole("button", { name: "Create schedule" }).click();
		await expect.element(screen.getByText("Choose the chat to continue.")).toBeVisible();

		await screen.getByLabelText("Chat", { exact: true }).selectOptions("__new__");
		await screen.getByRole("button", { name: "Create schedule" }).click();
		await expect.element(screen.getByText("Choose a model for the new chats.")).toBeVisible();
		await screen.getByLabelText("Model", { exact: true }).selectOptions("m2");
		await screen.getByRole("button", { name: "Create schedule" }).click();
		expect(api.createSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "chat",
				target: { mode: "new", model: "m2", permissionMode: "ask" },
			})
		);
		expect(api.createSchedule).toHaveBeenCalledTimes(1);
	});

	it("says up front when the sign-in gave no background access, and how to get it", async () => {
		const stub = vi.fn(
			async () =>
				new Response(superjson.stringify({ required: true, granted: false, chatSchedules: 0 }))
		);
		vi.stubGlobal("fetch", stub);
		try {
			const { screen } = mount({ prefill: { conversationId: "c1" } });
			await expect.element(screen.getByTestId("grant-card")).toHaveTextContent("offline_access");
			await expect
				.element(screen.getByTestId("grant-sign-in"))
				.toHaveAttribute("href", expect.stringContaining("/login?next="));
			// Saving without it says why instead of failing at the server.
			await screen.getByLabelText("Name", { exact: true }).fill("Weekly news");
			await screen.getByLabelText("Prompt", { exact: true }).fill("Summarise");
			await screen.getByRole("button", { name: "Create schedule" }).click();
			await expect.element(screen.getByText(/Background access is missing/)).toBeVisible();
			expect(api.createSchedule).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("says nothing about background access when it is there, or not needed", async () => {
		const stub = vi.fn(
			async () =>
				new Response(superjson.stringify({ required: true, granted: true, chatSchedules: 1 }))
		);
		vi.stubGlobal("fetch", stub);
		try {
			const { screen } = mount({ prefill: { conversationId: "c1" } });
			await expect.element(screen.getByTestId("chat-unattended-hint")).toBeVisible();
			expect(screen.getByTestId("grant-card").elements()).toHaveLength(0);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("offers Ask and Allow, Allow only for a person on always-allow, with the risk in a line", async () => {
		const { screen } = mount({ prefill: { conversationId: "c1" } });
		await expect.element(screen.getByTestId("perm-ask")).toHaveAttribute("aria-checked", "true");
		await expect.element(screen.getByTestId("perm-allow")).toBeDisabled();
		await expect.element(screen.getByText(/cannot be set to Allow/)).toBeVisible();
	});

	it("saves the permission mode with the target", async () => {
		const { screen } = mount({ prefill: { conversationId: "c1" } });
		await screen.getByLabelText("Name", { exact: true }).fill("n");
		await screen.getByLabelText("Prompt", { exact: true }).fill("p");
		await screen.getByRole("button", { name: "Create schedule" }).click();
		expect(api.createSchedule).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { mode: "continue", conversationId: "c1", permissionMode: "ask" },
			})
		);
	});

	it("tells everyone what scheduled runs cannot do", async () => {
		const { screen } = mount({ prefill: { conversationId: "c1" } });
		await expect
			.element(screen.getByTestId("chat-unattended-hint"))
			.toHaveTextContent("cannot run Python");
	});

	it("makes the kind of the area it was opened from, with no kind switch", async () => {
		setPage({ data: { codeSchedulesEnabled: true, conversations: [], models: [] } });
		const chat = mount({ kind: "chat" });
		expect(chat.screen.getByTestId("kind-chat").elements()).toHaveLength(0);
		expect(chat.screen.getByLabelText("1. Machine").elements()).toHaveLength(0);
		await expect.element(chat.screen.getByTestId("chat-unattended-hint")).toBeVisible();
		chat.screen.unmount();

		const agent = mount({ kind: "agent" });
		expect(agent.screen.getByTestId("kind-agent").elements()).toHaveLength(0);
		await expect.element(agent.screen.getByLabelText("1. Machine")).toBeVisible();
	});

	it("keeps the kind of the schedule it edits and shows its stored target", async () => {
		const { screen } = mount({
			editing: {
				id: "s1",
				kind: "chat",
				name: "Weekly news",
				prompt: "p",
				recurrence: { type: "daily", at: "09:00" },
				timezone: "UTC",
				enabled: true,
				target: { mode: "new", model: "m1" },
				targetLabel: "New chat each time",
				firedCount: 0,
			},
		});
		await expect.element(screen.getByLabelText("Chat", { exact: true })).toHaveValue("__new__");
		await expect.element(screen.getByLabelText("Model", { exact: true })).toHaveValue("m1");
		expect(screen.getByTestId("kind-chat").elements()).toHaveLength(0);
	});
});
