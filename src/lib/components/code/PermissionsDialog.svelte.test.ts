import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { get } from "svelte/store";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import PermissionsDialog from "./PermissionsDialog.svelte";
import { error as errorToast } from "$lib/stores/errors";
import { flagCodeReauth, resetCodeReauth } from "$lib/stores/codeReauth.svelte";
import { codeLegacyMachines } from "$lib/stores/codeLegacyMachines.svelte";
import { CodeApiError } from "$lib/codeApi";
import type { PermissionRulesResult } from "$lib/types/machineProtocol";

/**
 * The Permissions sheet shows what reaches the user on the machine, class by class (ADR 0107),
 * the session's exceptions with Remove on each, and a Coordination section
 * with two grant switches — the only other write. It reads the session's
 * `permission.rules` itself — that is what lets a session's ⋯ menu open it
 * for a row that is not the selection — and re-reads after the one write,
 * removing an exception by id through `removeSavedApproval` or granting
 * through `setCoordinationGrant`.
 *
 * MOCK: the rule lists below are the panel's reading of the frozen contract
 * with the agent half (feat/permission-selector-agent), not galopin's output.
 */
const fake = vi.hoisted(() => ({
	removed: [] as Array<{ agent: string; id: string }>,
	failRemove: null as string | null,
}));
const api = vi.hoisted(() => ({
	getPermissionRules: vi.fn(),
	getAutoApproval: vi.fn(),
	removeSavedApproval: vi.fn(),
	setCoordinationGrant: vi.fn(),
}));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => {
	const original = await importOriginal<typeof import("$lib/codeApi")>();
	return {
		...original,
		getPermissionRules: api.getPermissionRules,
		getAutoApproval: api.getAutoApproval,
		removeSavedApproval: api.removeSavedApproval,
		setCoordinationGrant: api.setCoordinationGrant,
	};
});

const DEVICE = { id: "d1", name: "studio-laptop", backends: [] } as never;

const RESULT: PermissionRulesResult = {
	mode: "ask",
	rules: [
		{ permission: "*", pattern: "*", action: "allow", source: "opencode" },
		{ permission: "edit", pattern: "*", action: "deny", source: "opencode" },
		{ permission: "*", pattern: "*", action: "ask", source: "cerea" },
		{ permission: "bash", pattern: "*", action: "ask", source: "ceiling" },
		{ permission: "bash", pattern: "git *", action: "allow", source: "opencode" },
		{ permission: "webfetch", pattern: "*", action: "deny", source: "machine" },
	],
	savedApprovals: [
		{ id: "ex_1", permission: "bash", patterns: ["npm test"], removable: true },
		{ id: "ex_2", permission: "bash", patterns: ["ls"], removable: true },
		{ id: "ex_3", permission: "edit", patterns: ["src/**"], removable: false },
	],
	ceiling: { bash: "ask" },
};

function mount(
	result: PermissionRulesResult | "404" | "stalled" = RESULT,
	extra: {
		policy?: Record<string, unknown>;
		onreenroll?: () => void;
		onchanged?: () => void;
		agentId?: string;
		mode?: "deny" | "ask" | "allow";
		setup?: unknown;
		device?: unknown;
	} = {}
) {
	if (result === "404") api.getPermissionRules.mockRejectedValue(new CodeApiError("gone", 404));
	else if (result === "stalled") api.getPermissionRules.mockRejectedValue(new Error("timed out"));
	else api.getPermissionRules.mockResolvedValue(result);
	return renderWithApp(PermissionsDialog, {
		deviceId: "d1",
		agentId: extra.agentId ?? "a1",
		device: DEVICE,
		onclose: () => {},
		...(extra as object),
	});
}

beforeEach(async () => {
	resetCodeReauth();
	for (const id of Object.keys(codeLegacyMachines)) delete codeLegacyMachines[id];
	fake.removed = [];
	fake.failRemove = null;
	errorToast.set(undefined);
	api.getPermissionRules.mockReset().mockResolvedValue(RESULT);
	api.getAutoApproval.mockReset().mockRejectedValue(new Error("none"));
	api.setCoordinationGrant
		.mockReset()
		.mockImplementation(async (_device: string, _agent: string, keys: string[]) => ({
			keys,
		}));
	api.removeSavedApproval
		.mockReset()
		.mockImplementation(async (_device: string, agent: string, id: string) => {
			if (fake.failRemove) throw new Error(fake.failRemove);
			fake.removed.push({ agent, id });
			return { ok: true };
		});
	await browserPage.viewport(1200, 800);
});

const PER_CLASS = {
	edit: "reviewer",
	command: "reviewer",
	web: "reviewer",
	outside: "reviewer",
	secrets: "you",
	agents: "reviewer",
	tools: "reviewer",
	loop: "you",
} as const;
const LIMITS = {
	edit: "allow",
	web: "allow",
	tools: "allow",
	agents: "allow",
	command: "ask",
	outside: "ask",
	secrets: "ask",
	loop: "ask",
} as const;
const policyOf = (limits?: Record<string, string>) =>
	({
		workspaceRoots: [],
		allowFreeModels: false,
		...(limits ? { limits } : { permission: { max: {} } }),
	}) as never;
const deviceOf = (policy: unknown) =>
	({ id: "d1", name: "studio-laptop", backends: [], policy }) as never;
const cell = (screen: ReturnType<typeof mount>, kind: "outcome" | "reason", c: string) =>
	screen.getByTestId(`permission-${kind}-${c}`);

describe("the Permissions sheet: what reaches you", () => {
	const reviewer = { reviewerAvailable: true, perClass: PER_CLASS };

	it("is titled with the machine and says what reaches you on Auto, with a row and a reason per class", async () => {
		const screen = mount(RESULT, {
			mode: "allow",
			setup: reviewer,
			device: deviceOf(policyOf({ ...LIMITS })),
		});
		await expect
			.element(screen.getByRole("heading", { name: "Permissions — studio-laptop" }))
			.toBeVisible();
		await expect
			.element(screen.getByTestId("permission-step"))
			.toHaveTextContent(
				"Auto on studio-laptop: edits, web, agents and tools run · commands and outside access are reviewed · secrets and loops come to you"
			);
		await expect.element(cell(screen, "outcome", "edit")).toHaveTextContent("Runs");
		await expect.element(cell(screen, "reason", "edit")).toHaveTextContent("This machine's limit");
		await expect.element(cell(screen, "outcome", "command")).toHaveTextContent("Reviewed");
		await expect.element(cell(screen, "reason", "command")).toHaveTextContent("Set by your admin");
		await expect.element(cell(screen, "outcome", "secrets")).toHaveTextContent("Comes to you");
		await expect.element(cell(screen, "reason", "loop")).toHaveTextContent("Always comes to you");
	});

	it("says what Plan and Ask mean in one sentence", async () => {
		let screen = mount(RESULT, { mode: "deny", setup: reviewer });
		await expect.element(screen.getByTestId("permission-step")).toHaveTextContent("Plan:");
		document.body.innerHTML = "";
		screen = mount(RESULT, { mode: "ask", setup: reviewer });
		await expect.element(screen.getByTestId("permission-step")).toHaveTextContent("Ask:");
	});

	it("on a machine with commands=run, commands run", async () => {
		const screen = mount(RESULT, {
			mode: "allow",
			setup: reviewer,
			device: deviceOf(policyOf({ ...LIMITS, command: "allow" })),
		});
		await expect.element(cell(screen, "outcome", "command")).toHaveTextContent("Runs");
		await expect
			.element(screen.getByTestId("permission-step"))
			.toHaveTextContent("edits, commands, web, agents and tools run");
	});

	it("on an older galopin derives the limits from the earlier settings and says so", async () => {
		const screen = mount(RESULT, {
			mode: "allow",
			setup: reviewer,
			device: deviceOf(policyOf()),
		});
		await expect.element(screen.getByTestId("permission-older")).toHaveTextContent("older galopin");
		await expect.element(cell(screen, "reason", "edit")).toHaveTextContent("older galopin");
		await expect.element(cell(screen, "outcome", "command")).toHaveTextContent("Reviewed");
	});

	it("with no reviewer, reads Allow and sends every ask to the user, because no reviewer is set up", async () => {
		const screen = mount(RESULT, {
			mode: "allow",
			setup: { reviewerAvailable: false, perClass: PER_CLASS },
			device: deviceOf(policyOf({ ...LIMITS })),
		});
		await expect
			.element(screen.getByTestId("permission-step"))
			.toHaveTextContent("Allow on studio-laptop:");
		await expect.element(cell(screen, "outcome", "command")).toHaveTextContent("Comes to you");
		await expect
			.element(cell(screen, "reason", "command"))
			.toHaveTextContent("No reviewer is set up here");
	});

	it("reads the reviewer's availability itself when the opener has none", async () => {
		api.getAutoApproval.mockResolvedValue({ available: true, perClass: PER_CLASS });
		const screen = mount(RESULT, { mode: "allow", device: deviceOf(policyOf({ ...LIMITS })) });
		await expect.element(cell(screen, "outcome", "command")).toHaveTextContent("Reviewed");
	});

	it("shows nothing of the backend: no tool names, no rule list, no raw rules", async () => {
		const screen = mount(RESULT, { mode: "allow", setup: reviewer });
		await expect.element(screen.getByTestId("permission-classes")).toBeVisible();
		expect(screen.getByTestId("permission-raw").elements()).toHaveLength(0);
		expect(screen.getByTestId("permission-rows").elements()).toHaveLength(0);
		expect(document.body.textContent).not.toMatch(/opencode|raw rules|webfetch|Asks first/i);
	});

	it("says it is reading while the machine has not answered", async () => {
		api.getPermissionRules.mockReturnValue(new Promise(() => {}));
		const screen = renderWithApp(PermissionsDialog, {
			deviceId: "d1",
			agentId: "a1",
			device: DEVICE,
			onclose: () => {},
		});
		await expect.element(screen.getByTestId("permissions-loading")).toBeVisible();
	});

	it("says the machine's agent is too old when the read 404s", async () => {
		const screen = mount("404");
		await expect
			.element(screen.getByTestId("permissions-unavailable"))
			.toHaveTextContent("too old");
	});

	it("says the machine did not answer on any other failed read", async () => {
		const screen = mount("stalled");
		await expect
			.element(screen.getByTestId("permissions-unavailable"))
			.toHaveTextContent("has not answered");
	});
});

describe("the Exceptions list", () => {
	it("lists each exception with what it covers, Remove only where the machine will withdraw it", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		const items = screen.getByTestId("permission-exception-item").elements();
		expect(items.map((el) => el.textContent?.replace(/\s+/g, " ").trim())).toEqual([
			"Allowed for this session: npm test Remove",
			"Allowed for this session: ls Remove",
			"Allowed for this session: src/** (edit) held by the machine",
		]);
		await expect.element(screen.getByText("held by the machine")).toBeVisible();
	});

	it("says exceptions last for this session, that Plan holds them back and that Ask restores them", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await expect
			.element(screen.getByText(/Exceptions last for this session only/))
			.toHaveTextContent(
				/Plan holds them back without deleting them; switching back to Ask restores them/
			);
	});

	it("with none, says how one is made", async () => {
		const screen = mount({ rules: [], savedApprovals: [], ceiling: {} });
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await expect.element(screen.getByText(/Always allow \(this session\)/)).toBeVisible();
	});

	it("removes an exception by id, then re-reads the rules itself and tells the parent", async () => {
		const onchanged = vi.fn();
		const screen = mount(RESULT, { onchanged });
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await screen.getByRole("button", { name: "Remove exception for bash" }).first().click();

		await vi.waitFor(() => expect(fake.removed).toEqual([{ agent: "a1", id: "ex_1" }]));
		await vi.waitFor(() => expect(onchanged).toHaveBeenCalledTimes(1));
		// One read on open, one after the removal: the dialog's own re-read.
		expect(api.getPermissionRules).toHaveBeenCalledTimes(2);
	});

	it("removes the second one by its own id", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await screen.getByRole("button", { name: "Remove exception for bash" }).nth(1).click();
		await vi.waitFor(() => expect(fake.removed).toEqual([{ agent: "a1", id: "ex_2" }]));
	});

	it("keeps the list and says why when the machine refuses", async () => {
		fake.failRemove = "No such exception.";
		const onchanged = vi.fn();
		const screen = mount(RESULT, { onchanged });
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await screen.getByRole("button", { name: "Remove exception for bash" }).first().click();

		await vi.waitFor(() => expect(get(errorToast)).toBe("No such exception."));
		expect(fake.removed).toEqual([]);
		expect(onchanged).not.toHaveBeenCalled();
		expect(api.getPermissionRules).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("permission-exception-item").elements()).toHaveLength(3);
	});
});

describe("while the /code sign-in is stale", () => {
	it("the whole line goes, Remove with it", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Remove exception for bash" }).first())
			.toBeVisible();

		flagCodeReauth();
		await vi.waitFor(() =>
			expect(screen.getByTestId("permissions-detail").elements()).toHaveLength(0)
		);
		expect(screen.getByRole("button", { name: /Remove exception/ }).elements()).toHaveLength(0);
		expect(fake.removed).toEqual([]);
	});

	it("does not draw at all if the sign-in is already stale on arrival", async () => {
		flagCodeReauth();
		const screen = mount();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.getByTestId("permissions-detail").elements()).toHaveLength(0);
		expect(screen.getByTestId("permissions-unavailable").elements()).toHaveLength(0);
		await expect.element(screen.getByRole("heading", { name: "Permissions" })).toBeVisible();
	});
});

describe("a machine that predates ceilings", () => {
	const LEGACY_POLICY = { workspaceRoots: [], allowFreeModels: false, permission: { max: {} } };
	const ENROLLED_POLICY = {
		workspaceRoots: [],
		allowFreeModels: false,
		permission: { max: { bash: "ask" } },
	};
	const ALLOW_ALL: PermissionRulesResult = {
		rules: [{ permission: "*", pattern: "*", action: "allow", source: "opencode" }],
		savedApprovals: [],
		ceiling: {},
	};

	it("is flagged, up front, when hello has an empty ceiling and the rules have no file rules", async () => {
		const onreenroll = vi.fn();
		const screen = mount(ALLOW_ALL, { policy: LEGACY_POLICY, onreenroll });
		const flag = screen.getByTestId("legacy-machine-flag");
		// Visible without opening the detail.
		await expect.element(flag).toBeVisible();
		await expect.element(flag).toHaveTextContent("Re-enroll this machine to set limits");
		await expect.element(flag).toHaveTextContent("predates ceilings");
		await expect.element(flag).toHaveTextContent("nothing caps Allow");
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await screen.getByRole("button", { name: "Re-enroll this machine" }).click();
		expect(onreenroll).toHaveBeenCalledTimes(1);
		// Remembered for the machine's row in the tree.
		await vi.waitFor(() => expect(codeLegacyMachines.d1).toBe(true));
	});

	it("is not flagged for a properly enrolled machine", async () => {
		const screen = mount(RESULT, { policy: ENROLLED_POLICY });
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		expect(screen.getByTestId("legacy-machine-flag").elements()).toHaveLength(0);
		await vi.waitFor(() => expect(codeLegacyMachines.d1).toBe(false));
	});

	it("is not flagged when the rules carry the ask block, even with no ceiling", async () => {
		const screen = mount(
			{
				rules: [
					{ permission: "*", pattern: "*", action: "allow", source: "opencode" },
					{ permission: "edit", pattern: "*", action: "ask", source: "file" },
				],
				savedApprovals: [],
				ceiling: {},
			},
			{ policy: LEGACY_POLICY }
		);
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		expect(screen.getByTestId("legacy-machine-flag").elements()).toHaveLength(0);
	});

	it("clears when a re-enroll gives the machine a ceiling", async () => {
		const screen = mount(ALLOW_ALL, { policy: LEGACY_POLICY });
		await expect.element(screen.getByTestId("legacy-machine-flag")).toBeVisible();
		// The machine re-enrolled: its next read carries the ceiling. The
		// dialog re-reads whenever the session it is open for changes, so
		// this is one reopen away.
		api.getPermissionRules.mockResolvedValue({
			rules: [
				{ permission: "*", pattern: "*", action: "allow", source: "opencode" },
				{ permission: "bash", pattern: "*", action: "ask", source: "ceiling" },
			],
			savedApprovals: [],
			ceiling: { bash: "ask" },
		});
		await screen.rerender({
			deviceId: "d1",
			agentId: "a2",
			device: DEVICE,
			policy: ENROLLED_POLICY,
		});
		await vi.waitFor(() =>
			expect(screen.getByTestId("legacy-machine-flag").elements()).toHaveLength(0)
		);
		await vi.waitFor(() => expect(codeLegacyMachines.d1).toBe(false));
	});
});

describe("Permissions dialog coordination", () => {
	const MESSAGE = ["session_list", "session_read", "session_send"];
	const device = (over: Record<string, unknown> = {}) =>
		({
			id: "d1",
			name: "Box",
			backends: [{ id: "opencode", capabilities: { coordinationGrant: true } }],
			...over,
		}) as never;

	const boxes = (screen: ReturnType<typeof mount>) =>
		screen
			.getByTestId("coordination-options")
			.element()
			.querySelectorAll<HTMLInputElement>("input[type='checkbox']");
	const noOptions = (screen: ReturnType<typeof mount>) =>
		screen.getByTestId("coordination-options").elements();

	function mountGrant(
		coordination: string[],
		extra: { device?: unknown; subagent?: boolean; onchanged?: () => void } = {}
	) {
		api.getPermissionRules.mockResolvedValue({ ...RESULT, coordination });
		return renderWithApp(PermissionsDialog, {
			deviceId: "d1",
			agentId: "a1",
			device: DEVICE,
			onclose: () => {},
			...(extra as object),
		});
	}

	it("reads the initial switches from the session's own grant", async () => {
		const screen = mountGrant(MESSAGE, { device: device() });
		await expect.element(screen.getByTestId("coordination-options")).toBeVisible();
		const [message, spawn] = [...boxes(screen)];
		expect(message.checked).toBe(true);
		expect(spawn.checked).toBe(false);
	});

	it("a partial grant leaves the message switch off", async () => {
		const screen = mountGrant(["session_send"], { device: device() });
		await expect.element(screen.getByTestId("coordination-options")).toBeVisible();
		expect([...boxes(screen)][0].checked).toBe(false);
	});

	it("toggling sends the whole new set, re-reads, and tells the parent", async () => {
		const onchanged = vi.fn();
		const screen = mountGrant([], { device: device(), onchanged });
		await expect.element(screen.getByTestId("coordination-options")).toBeVisible();
		// The machine's answer is the receipt; the dialog believes its
		// re-read, so point the next read at the granted set now.
		api.getPermissionRules.mockResolvedValue({ ...RESULT, coordination: MESSAGE });
		const [message, spawn] = [...boxes(screen)];
		expect(message.checked).toBe(false);
		message.click();
		await vi.waitFor(() =>
			expect(api.setCoordinationGrant).toHaveBeenCalledWith("d1", "a1", MESSAGE)
		);
		await vi.waitFor(() => expect([...boxes(screen)][0].checked).toBe(true));
		await vi.waitFor(() => expect(onchanged).toHaveBeenCalled());
		expect(spawn.checked).toBe(false);
	});

	it("clearing the last switch clears the grant", async () => {
		const screen = mountGrant(MESSAGE, { device: device() });
		await expect.element(screen.getByTestId("coordination-options")).toBeVisible();
		[...boxes(screen)][0].click();
		await vi.waitFor(() => expect(api.setCoordinationGrant).toHaveBeenCalledWith("d1", "a1", []));
	});

	it("a galopin too old to grant disables the switches with the reason", async () => {
		const screen = mountGrant([], { device: device({ backends: [{ capabilities: {} }] }) });
		await expect.element(screen.getByTestId("coordination-unavailable")).toBeVisible();
		await expect
			.element(screen.getByTestId("coordination-unavailable"))
			.toHaveTextContent("too old to grant coordination");
		expect(noOptions(screen)).toHaveLength(0);
	});

	it("agent tools off disables the switches with its own reason", async () => {
		const screen = mountGrant([], {
			device: device({ policy: { agentTools: "denied" } }),
		});
		await expect
			.element(screen.getByTestId("coordination-unavailable"))
			.toHaveTextContent("without agent tools");
	});

	it("a subagent gets the note, not the switches", async () => {
		const screen = mountGrant(MESSAGE, { device: device(), subagent: true });
		await expect.element(screen.getByText(/follows its root's setting/)).toBeVisible();
		expect(noOptions(screen)).toHaveLength(0);
	});

	it("without a device row the switches stay usable", async () => {
		const screen = mountGrant([], { device: undefined });
		await expect.element(screen.getByTestId("coordination-options")).toBeVisible();
	});

	it("a ceiling that caps a granted key is said under the switches", async () => {
		const screen = mountGrant(MESSAGE, {
			device: device({ policy: { permission: { max: { session_send: "ask" } } } }),
		});
		await expect.element(screen.getByText(/caps messaging sessions at Ask/)).toBeVisible();
	});
});
