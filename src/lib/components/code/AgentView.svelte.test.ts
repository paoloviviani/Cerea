import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentView from "./AgentView.svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { MessageElicitationUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import { permissionToElicitation } from "$lib/utils/codeInboxCards";
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";
import type { PlanStep } from "$lib/types/Plan";

/**
 * The machine is a fake: the stream is a gate the test opens with the frames
 * it wants, and the api answers only what the header needs. What is under test
 * is the view's own decision about when the Tasks pane opens by itself.
 */
const fake = vi.hoisted(() => ({
	frames: [] as unknown[],
	release: null as null | (() => void),
	/** MOCK of the frozen contract with the agent half: the machine's word on
	 * the session's mode, its ceiling, and what the panel asked of it. */
	mode: "ask" as "deny" | "ask" | "allow",
	parentId: null as string | null,
	ceiling: {} as Record<string, "ask" | "deny">,
	setCalls: [] as string[],
	/** Each subagent's own transcript, by session id (MOCK of the timeline route). */
	timelines: {} as Record<string, unknown[]>,
	ruleReads: 0,
	snapshotReads: 0,
	/** A background child counts as running until this many snapshot reads. */
	childRunningUntilRead: 0,
	/** End the mocked stream after the frames (no live tail, no marker):
	 * the `reauth_required`/`end` path a real EventSource can take. */
	endStream: false,
}));

// The composer's MCP stores read `$env/dynamic/public` at module scope and
// fetch on import; no SvelteKit env or API exists in the browser project.
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeAgentStream", () => ({
	agentStreamUrl: () => "",
	async *codeAgentStream(_device: string, _agent: string, signal: AbortSignal) {
		// Held until the test says the frames have "arrived".
		await new Promise<void>((resolve) => {
			fake.release = resolve;
			signal.addEventListener("abort", () => resolve());
		});
		for (const frame of fake.frames) yield frame as AgentStreamUpdate;
		// The real bridge ends its history replay with this marker before
		// tailing (see the stream endpoint); the view gates its first paint
		// on it, so a test's frames are the history and need it too.
		yield { type: "historyDone" };
		if (fake.endStream) return;
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
	},
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	getAgent: async () => {
		fake.snapshotReads += 1;
		return {
			agent: {
				id: "a1",
				workspaceId: "w1",
				title: "Build it",
				provider: "opencode",
				state: "idle",
				updatedAt: "2026-09-30T00:00:00Z",
				modeId: null,
				modelId: null,
				permissionMode: fake.mode,
				parentId: fake.parentId,
				...(fake.childRunningUntilRead > 0
					? {
							childSummary: {
								children: 1,
								running: fake.snapshotReads <= fake.childRunningUntilRead ? 1 : 0,
								waiting: 0,
							},
						}
					: {}),
			},
			cwd: "/w",
			enrollmentExpired: false,
		};
	},
	fetchSubagentTimeline: async (_device: string, _agent: string, child: string) => ({
		updates: fake.timelines[child] ?? [],
	}),
	setPermissionMode: async (_device: string, _agent: string, mode: "deny" | "ask" | "allow") => {
		fake.setCalls.push(mode);
		fake.mode = mode;
		return { ok: true };
	},
	listWorkspaces: async () => ({ workspaces: [] }),
	listSubagents: async () => ({ subagents: [] }),
	listProviderModes: async () => ({ modes: [] }),
	listProviderModels: async () => ({ models: [] }),
	// MOCK of the contract with the agent half: a read of opencode's rules.
	getPermissionRules: async () => {
		fake.ruleReads += 1;
		return {
			mode: fake.mode,
			rules: [
				{ permission: "edit", pattern: "*", action: "ask", source: "cerea" },
				{ permission: "bash", pattern: "*", action: "deny", source: "ceiling" },
				{ permission: "webfetch", pattern: "*", action: "allow", source: "opencode" },
			],
			savedApprovals: [{ id: "ex_1", permission: "edit", patterns: ["src/**"], removable: true }],
			ceiling: fake.ceiling,
		};
	},
}));

const plan = (steps: PlanStep[]) => ({
	type: MessageUpdateType.Plan,
	uuid: "agent-plan-a1",
	goal: steps[0]?.step ?? "",
	version: 1,
	steps,
});
const ACTIVE = plan([
	{ step: "write the view", status: "in_progress" },
	{ step: "ship", status: "pending" },
]);

function mount() {
	codeDeviceList.devices = [
		{ id: "d1", name: "Box", status: "paired", online: true },
	] as typeof codeDeviceList.devices;
	codeDeviceList.loading = false;
	return renderWithApp(AgentView, { deviceId: "d1", agentId: "a1", workspaceId: "w1" });
}

async function arrive(frames: unknown[]) {
	await vi.waitFor(() => expect(fake.release).not.toBeNull());
	fake.frames = frames;
	fake.release?.();
}

beforeEach(() => {
	fake.frames = [];
	fake.release = null;
	fake.mode = "ask";
	fake.parentId = null;
	fake.ceiling = {};
	fake.setCalls = [];
	fake.timelines = {};
	fake.ruleReads = 0;
	fake.snapshotReads = 0;
	fake.childRunningUntilRead = 0;
	fake.endStream = false;
	sidePane.reset();
});

describe("AgentView Tasks pane", () => {
	it("opens itself once for an active list on a wide screen, and stays closed after a close", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		expect(sidePane.open).toBe(false);
		await arrive([ACTIVE]);
		await expect.element(screen.getByTestId("code-tasks")).toBeVisible();
		expect(sidePane.view).toBe("tasks");

		// The person closes it: the same list does not bring it back, even as
		// it moves along (same session, same first item).
		sidePane.close();
		fake.frames = [];
		await expect.element(screen.getByRole("button", { name: "Tasks 0/2" })).toBeVisible();
		expect(sidePane.open).toBe(false);
	});

	it("never replaces a view that is already open, and does not come back when it closes", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		sidePane.openDiff();
		await arrive([ACTIVE]);
		await expect.element(screen.getByRole("button", { name: "Tasks 0/2" })).toBeVisible();
		expect(sidePane.view).toBe("diff");
		expect(sidePane.open).toBe(true);

		sidePane.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(sidePane.open).toBe(false);
	});

	it("never opens on a narrow viewport", async () => {
		await browserPage.viewport(400, 800);
		const screen = mount();
		await arrive([ACTIVE]);
		await expect.element(screen.getByRole("button", { name: "Tasks 0/2" })).toBeVisible();
		// The label is folded away here; the count stays visible.
		await expect.element(screen.getByTestId("pill-badge")).toHaveTextContent("0/2");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(sidePane.open).toBe(false);
	});

	it("does not open for a list that is finished, and the pill still counts it", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await arrive([plan([{ step: "done already", status: "completed" }])]);
		await expect.element(screen.getByRole("button", { name: "Tasks 1/1" })).toBeVisible();
		expect(sidePane.open).toBe(false);
	});
});

describe("AgentView Permissions strip", () => {
	it("no longer holds the permissions line: the strip has no permission rows at all", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByTestId("permissions-line").elements()).toHaveLength(0);
		expect(screen.getByTestId("permission-summary").elements()).toHaveLength(0);
		expect(screen.getByTestId("permissions-detail").elements()).toHaveLength(0);
	});
});

describe("AgentView permission selector", () => {
	it("shows the machine's word, and changing it sends the op then re-reads the snapshot and the rules", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		const group = screen.getByRole("radiogroup", { name: "Permission for this session" });
		await expect.element(group).toBeVisible();
		await expect
			.element(screen.getByTestId("permission-mode-ask"))
			.toHaveAttribute("aria-checked", "true");
		await vi.waitFor(() => expect(fake.ruleReads).toBeGreaterThan(0));
		const reads = fake.ruleReads;
		const snapshots = fake.snapshotReads;

		// Dispatched on the element: this harness renders the view without the
		// page's own `pointer-events-auto` composer shell, so a pointer-driven
		// click lands on the view's `pointer-events-none` root (the composer's own
		// specs click it with a real pointer).
		(screen.getByTestId("permission-mode-allow").element() as HTMLElement).click();
		await vi.waitFor(() => expect(fake.setCalls).toEqual(["allow"]));
		// Not claimed from the click: claimed once the snapshot says so.
		await expect
			.element(screen.getByTestId("permission-mode-allow"))
			.toHaveAttribute("aria-checked", "true");
		await expect
			.element(screen.getByTestId("permission-mode-ask"))
			.toHaveAttribute("aria-checked", "false");
		expect(fake.snapshotReads).toBeGreaterThan(snapshots);
		expect(fake.ruleReads).toBeGreaterThan(reads);
	});

	it("names what the ceiling still caps under Allow, from permission.rules", async () => {
		await browserPage.viewport(1200, 800);
		fake.mode = "allow";
		fake.ceiling = { bash: "ask" };
		const screen = mount();
		await expect
			.element(screen.getByTestId("permission-mode-note"))
			.toHaveTextContent("Allow · bash asks (machine limit)");
	});

	it("is disabled on a subagent's view, saying it follows the main session", async () => {
		await browserPage.viewport(1200, 800);
		fake.parentId = "root-1";
		fake.mode = "deny";
		const screen = mount();
		await expect
			.element(screen.getByTestId("permission-mode-deny"))
			.toHaveAttribute("aria-checked", "true");
		await expect.element(screen.getByTestId("permission-mode-allow")).toBeDisabled();
		await expect
			.element(screen.getByTestId("permission-mode-note"))
			.toHaveTextContent("Follows the main session");
		expect(fake.setCalls).toEqual([]);
	});

	it("hides the card's Always button for a key the ceiling caps, and offers it for one it does not", async () => {
		await browserPage.viewport(1200, 800);
		fake.ceiling = { bash: "ask" };
		const screen = mount();
		await vi.waitFor(() => expect(fake.ruleReads).toBeGreaterThan(0));
		const ask = (id: string, tool: string) => ({
			type: MessageUpdateType.Elicitation,
			subtype: MessageElicitationUpdateType.Request,
			request: permissionToElicitation({
				id,
				sessionId: "a1",
				tool,
				title: `run ${tool}`,
				patterns: ["x"],
				metadata: {},
				always: ["x"],
			}),
		});
		await arrive([ask("p-bash", "bash"), ask("p-edit", "edit")]);
		await expect
			.element(screen.getByRole("button", { name: "Always allow (this session)" }))
			.toBeVisible();
		// One card has the button (edit), the capped one (bash) does not.
		expect(
			screen.getByRole("button", { name: "Always allow (this session)" }).elements()
		).toHaveLength(1);
		expect(screen.getByRole("button", { name: "Allow once" }).elements()).toHaveLength(2);
	});

	describe("a new subagent's first turn", () => {
		const childAsk = (id: string, child: string) => ({
			type: MessageUpdateType.Elicitation,
			subtype: MessageElicitationUpdateType.Request,
			request: permissionToElicitation(
				{
					id,
					sessionId: child,
					tool: "edit",
					title: "write a file",
					patterns: ["x"],
					metadata: {},
					always: [],
				},
				{ childId: child, childTitle: "Researcher" }
			),
		});

		it("is named on a subagent's ask while that subagent has had only its starting prompt", async () => {
			await browserPage.viewport(1200, 800);
			fake.mode = "allow";
			fake.timelines = { "child-1": [{ type: "user", text: "look around" }] };
			const screen = mount();
			await arrive([childAsk("p-1", "child-1")]);
			await expect
				.element(screen.getByTestId("first-turn-chip"))
				.toHaveTextContent("New subagent · first turn asks");
		});

		it("is not named once the subagent has had another turn", async () => {
			await browserPage.viewport(1200, 800);
			fake.mode = "allow";
			fake.timelines = {
				"child-1": [
					{ type: "user", text: "look around" },
					{ type: "user", text: "now this" },
				],
			};
			const screen = mount();
			await arrive([childAsk("p-1", "child-1")]);
			await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
		});

		it("is not named on the main session's own ask", async () => {
			await browserPage.viewport(1200, 800);
			fake.mode = "allow";
			const screen = mount();
			await arrive([
				{
					type: MessageUpdateType.Elicitation,
					subtype: MessageElicitationUpdateType.Request,
					request: permissionToElicitation({
						id: "p-root",
						sessionId: "a1",
						tool: "edit",
						title: "write a file",
						patterns: ["x"],
						metadata: {},
						always: [],
					}),
				},
			]);
			await expect.element(screen.getByRole("button", { name: "Allow once" })).toBeVisible();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(screen.getByTestId("first-turn-chip").elements()).toHaveLength(0);
		});
	});
});

describe("AgentView background banner", () => {
	it("clears when the child finishes, even if its last signal lands just after a poll", async () => {
		await browserPage.viewport(1200, 800);
		fake.childRunningUntilRead = 1000;
		const screen = mount();
		await expect
			.element(screen.getByText("A subagent is still running in the background."))
			.toBeVisible();
		// The next read after the first activity frame still says running; the one
		// after the second (held until the throttle window ends) says it is done.
		fake.childRunningUntilRead = fake.snapshotReads + 1;
		await arrive([
			{ type: "childActivity", childId: "c1" },
			{ type: "childActivity", childId: "c1" },
		]);
		await expect
			.element(screen.getByText("A subagent is still running in the background."))
			.not.toBeInTheDocument();
	});
});

describe("AgentView fork action", () => {
	const boundary = (role: "user" | "assistant", messageId: string) => ({
		type: "messageBoundary",
		role,
		messageId,
	});
	const echo = (text: string) => ({ type: "user", text });
	const stream = (token: string, partId: string) => ({
		type: MessageUpdateType.Stream,
		token,
		partId,
	});
	const turnState = (state: "running" | "done" | "failed") => ({
		type: MessageUpdateType.TurnState,
		state,
		serverNow: 0,
	});
	const forkButtons = (screen: { baseElement: HTMLElement }) =>
		screen.baseElement.querySelectorAll<HTMLButtonElement>('button[aria-label="Fork from here"]');

	it("offers the fork on every named assistant message of a finished multi-turn session", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		// A snapshot of a finished three-turn session; the first turn ran two
		// steps (two wire assistant messages, folded into one bubble).
		await arrive([
			boundary("user", "u1"),
			echo("first"),
			boundary("assistant", "a1"),
			stream("Step one. ", "p1"),
			boundary("assistant", "a1b"),
			stream("Step two.", "p2"),
			boundary("user", "u2"),
			echo("second"),
			boundary("assistant", "a2"),
			stream("Second.", "p3"),
			boundary("user", "u3"),
			echo("third"),
			boundary("assistant", "a3"),
			stream("Third.", "p4"),
			turnState("done"),
		]);
		await expect.element(screen.getByText("Third.")).toBeVisible();
		expect(forkButtons(screen)).toHaveLength(3);
	});

	it("still offers the fork when a later turn dies without an answer", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		// The next turn's busy beats its echo (the captured opencode order), so
		// the fold adopts turn one's finished message and sticks it at running
		// after its own done; the turn then dies before producing any part, and
		// the failure parks on that same message. The message's own turn state
		// now reads neither done nor done — the fork must still be offered.
		await arrive([
			boundary("user", "u1"),
			echo("first"),
			boundary("assistant", "a1"),
			stream("Answer one.", "p1"),
			turnState("done"),
			turnState("running"),
			boundary("user", "u2"),
			echo("second"),
			turnState("failed"),
		]);
		await expect.element(screen.getByText("Answer one.")).toBeVisible();
		expect(forkButtons(screen)).toHaveLength(1);
	});

	it("offers nothing while the turn still runs", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await arrive([
			boundary("user", "u1"),
			echo("first"),
			boundary("assistant", "a1"),
			stream("First.", "p1"),
			turnState("done"),
			boundary("user", "u2"),
			echo("second"),
			boundary("assistant", "a2"),
			stream("Working...", "p2"),
			turnState("running"),
		]);
		await expect.element(screen.getByText("Working...")).toBeVisible();
		expect(forkButtons(screen)).toHaveLength(0);
	});
});

describe("AgentView transcript loading", () => {
	it("shows a loading state until the history lands, then the whole transcript", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		// The stream is held: nothing has arrived yet, and the pane must say
		// so — not the empty-session introduction, and not a blank pane.
		await expect.element(screen.getByTestId("transcript-loading")).toBeVisible();
		await expect.element(screen.getByText("Loading conversation…")).toBeVisible();
		await expect.element(screen.getByText("Ready when you are")).not.toBeInTheDocument();
		// Folded while gated: no half-built transcript leaks either.
		await arrive([
			{ type: "user", text: "the first prompt" },
			{ type: "stream", token: "an answer" },
			{ type: "turnState", state: "done", serverNow: 0 },
			{ type: "historyDone" },
		]);
		await expect.element(screen.getByTestId("transcript-loading")).not.toBeInTheDocument();
		await expect.element(screen.getByText("the first prompt")).toBeVisible();
		await expect.element(screen.getByText("an answer")).toBeVisible();
	});

	it("clears the loading state when the stream ends without the marker", async () => {
		await browserPage.viewport(1200, 800);
		fake.endStream = true;
		const screen = mount();
		await expect.element(screen.getByTestId("transcript-loading")).toBeVisible();
		// The connection ended (a 7-day sign-in lapse closes it): whatever
		// folded is shown, never a skeleton left forever.
		await arrive([{ type: "user", text: "partial" }]);
		await expect.element(screen.getByTestId("transcript-loading")).not.toBeInTheDocument();
		await expect.element(screen.getByText("partial")).toBeVisible();
	});
});
