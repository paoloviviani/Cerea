import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { get } from "svelte/store";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import PermissionsDialog from "./PermissionsDialog.svelte";
import { error as errorToast } from "$lib/stores/errors";
import { flagCodeReauth, resetCodeReauth } from "$lib/stores/codeReauth.svelte";
import * as s from "$lib/components/overlay/styles";
import { codeLegacyMachines } from "$lib/stores/codeLegacyMachines.svelte";
import { CodeApiError } from "$lib/codeApi";
import type { PermissionRulesResult } from "$lib/types/machineProtocol";

/**
 * The Permissions dialog shows what the machine says is in force as one
 * plain row per capability (the final answer, worked out from the rules),
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
		removeSavedApproval: api.removeSavedApproval,
		setCoordinationGrant: api.setCoordinationGrant,
	};
});

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
	} = {}
) {
	if (result === "404") api.getPermissionRules.mockRejectedValue(new CodeApiError("gone", 404));
	else if (result === "stalled") api.getPermissionRules.mockRejectedValue(new Error("timed out"));
	else api.getPermissionRules.mockResolvedValue(result);
	return renderWithApp(PermissionsDialog, {
		deviceId: "d1",
		agentId: extra.agentId ?? "a1",
		sessionTitle: "Build it",
		onclose: () => {},
		...(extra as object),
	});
}

const rowText = (screen: ReturnType<typeof mount>, id: string) =>
	screen
		.getByTestId("permission-row")
		.elements()
		.find((el) => el.getAttribute("data-row") === id)
		?.textContent?.replace(/\s+/g, " ")
		.trim();

beforeEach(async () => {
	resetCodeReauth();
	for (const id of Object.keys(codeLegacyMachines)) delete codeLegacyMachines[id];
	fake.removed = [];
	fake.failRemove = null;
	errorToast.set(undefined);
	api.getPermissionRules.mockReset().mockResolvedValue(RESULT);
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

describe("Permissions dialog heading", () => {
	it("names the session and carries the capability rows in plain words", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		// edit: Cerea's ask block replaces opencode's deny; bash: the ceiling's ask; webfetch: the machine's deny.
		await expect
			.element(screen.getByRole("heading", { name: "Permissions — Build it" }))
			.toBeVisible();
		expect(rowText(screen, "edit")).toBe("Edit and write files Asks first");
		expect(rowText(screen, "bash")).toBe("Run commands Asks first");
		expect(rowText(screen, "web")).toBe("Fetch from the web Blocked");
		expect(screen.getByTestId("permission-exception-item").elements()).toHaveLength(3);
	});

	it("reads the rules for the session it was opened for, itself", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		expect(api.getPermissionRules).toHaveBeenCalledWith("d1", "a1");
	});

	it("says it is reading while the machine has not answered", async () => {
		let settle: (value: PermissionRulesResult) => void = () => {};
		api.getPermissionRules.mockImplementation(
			() => new Promise<PermissionRulesResult>((resolve) => (settle = resolve))
		);
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-loading")).toBeVisible();
		settle(RESULT);
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
	});

	it("says the machine's agent is too old when the read 404s (a machine without the op)", async () => {
		const screen = mount("404");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByTestId("permissions-detail").elements()).toHaveLength(0);
		await expect.element(screen.getByTestId("permissions-unavailable")).toBeVisible();
		await expect
			.element(screen.getByTestId("permissions-unavailable"))
			.toHaveTextContent(/too old to report permissions/);
	});

	it("says the machine did not answer on any other failed read", async () => {
		const screen = mount("stalled");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByTestId("permissions-detail").elements()).toHaveLength(0);
		await expect
			.element(screen.getByTestId("permissions-unavailable"))
			.toHaveTextContent(/has not answered yet/);
	});

	it("lists a single exception by itself", async () => {
		const screen = mount({
			rules: [],
			savedApprovals: [{ id: "ex_1", permission: "bash", patterns: ["ls"], removable: true }],
			ceiling: {},
		});
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		expect(screen.getByTestId("permission-exception-item").elements()).toHaveLength(1);
	});
});

describe("Permissions line detail", () => {
	it("gives one row per capability with its final answer, however often the raw list repeats it", async () => {
		const screen = mount({
			rules: [
				{ permission: "question", pattern: "*", action: "ask", source: "cerea" },
				{ permission: "question", pattern: "*", action: "allow", source: "opencode" },
				{ permission: "question", pattern: "*", action: "deny", source: "file" },
				{ permission: "question", pattern: "*", action: "allow", source: "cerea" },
				{ permission: "edit", pattern: "*", action: "deny", source: "machine" },
			],
			savedApprovals: [],
			ceiling: {},
		});
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		expect(rowText(screen, "question")).toBe("Ask you questions Allowed");
		expect(rowText(screen, "edit")).toBe("Edit and write files Blocked");
		// Nothing says anything about bash: opencode asks.
		expect(rowText(screen, "bash")).toBe("Run commands Asks first");
		expect(screen.getByTestId("permission-row").elements()).toHaveLength(8);
	});

	it("uses the pill tones: green allowed, grey asks first, red blocked", async () => {
		const screen = mount({
			rules: [
				{ permission: "*", pattern: "*", action: "ask" },
				{ permission: "edit", pattern: "*", action: "allow" },
				{ permission: "bash", pattern: "*", action: "deny" },
			],
			savedApprovals: [],
			ceiling: {},
		});
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		const pill = (id: string) =>
			screen
				.getByTestId("permission-row")
				.elements()
				.find((el) => el.getAttribute("data-row") === id)
				?.querySelector("span:nth-child(2)")?.className ?? "";
		expect(pill("edit")).toContain(s.PILL_TONES.good);
		expect(pill("web")).toContain(s.PILL_TONES.neutral);
		expect(pill("bash")).toContain(s.PILL_TONES.bad);
	});

	it("notes the secret files read asks about", async () => {
		const screen = mount({
			rules: [
				{ permission: "read", pattern: "*", action: "allow", source: "opencode" },
				{ permission: "read", pattern: "*.env", action: "ask", source: "opencode" },
			],
			savedApprovals: [],
			ceiling: {},
		});
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		expect(rowText(screen, "read")).toBe("Read files Allowed except secret files like .env: ask");
	});

	it("says when the machine's limits hold a row below the session's setting", async () => {
		const screen = mount({
			mode: "allow",
			rules: [
				{ permission: "*", pattern: "*", action: "allow", source: "cerea" },
				{ permission: "bash", pattern: "*", action: "ask", source: "ceiling" },
			],
			savedApprovals: [],
			ceiling: { bash: "ask" },
		});
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		expect(rowText(screen, "bash")).toBe("Run commands Asks first limited by this machine");
		expect(rowText(screen, "edit")).toBe("Edit and write files Allowed");
		expect(screen.getByTestId("permission-capped").elements()).toHaveLength(1);
	});

	it("says what drives it, and keeps the raw rules closed until asked", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await expect
			.element(screen.getByText(/Set by this session's Deny \/ Ask \/ Allow switch/))
			.toHaveTextContent("within the limits this machine was enrolled with");
		await expect.element(screen.getByTestId("permission-rules")).not.toBeVisible();
	});

	it("shows a rule Cerea's block replaces as overridden in the raw list, and an unreplaced one with its source", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await screen.getByText("Show the raw rules (for troubleshooting)").click();
		await expect.element(screen.getByTestId("permission-rules")).toBeVisible();
		const overridden = screen.getByText("overridden by Cerea");
		await expect.element(overridden.first()).toBeVisible();
		// Two: opencode's own `* allow` and `edit deny`, which Cerea's `* ask`
		// block (the session's mode, listed after them) replaces.
		expect(overridden.elements()).toHaveLength(2);
		const rows = screen.getByTestId("permission-rule").elements();
		const struck = rows.filter((el) => el.getAttribute("data-overridden") === "true");
		expect(struck).toHaveLength(2);
		expect(struck.map((el) => el.textContent?.replace(/\s+/g, " ").trim())).toEqual([
			"* allow overridden by Cerea",
			"edit deny overridden by Cerea",
		]);
		// `bash git *: allow` is opencode's and nothing later covers it.
		const gitRule = rows.find((el) => el.textContent?.includes("git *"));
		expect(gitRule?.getAttribute("data-overridden")).toBe("false");
		expect(gitRule?.textContent).toContain("opencode's rules");
	});

	it("names the machine's floor and its limits when they replace a rule", async () => {
		const screen = mount({
			rules: [
				{ permission: "bash", pattern: "*", action: "allow", source: "opencode" },
				{ permission: "bash", pattern: "*", action: "ask", source: "floor" },
				{ permission: "edit", pattern: "*", action: "allow", source: "opencode" },
				{ permission: "edit", pattern: "*", action: "deny", source: "ceiling" },
			],
			savedApprovals: [],
			ceiling: {},
		});
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await screen.getByText("Show the raw rules (for troubleshooting)").click();
		await expect.element(screen.getByTestId("permission-rules")).toBeVisible();
		await expect.element(screen.getByText("overridden by this machine's floor")).toBeVisible();
		await expect.element(screen.getByText("overridden by this machine's limits")).toBeVisible();
	});

	it("shows a rule with no source plainly in the raw list: no label, never overridden", async () => {
		const screen = mount({
			rules: [
				{ permission: "edit", pattern: "*", action: "deny" },
				{ permission: "edit", pattern: "*", action: "allow", source: "cerea" },
			],
			savedApprovals: [],
			ceiling: {},
		});
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await screen.getByText("Show the raw rules (for troubleshooting)").click();
		await expect.element(screen.getByTestId("permission-rules")).toBeVisible();
		const rows = screen.getByTestId("permission-rule").elements();
		expect(rows).toHaveLength(2);
		expect(rows[0].getAttribute("data-overridden")).toBe("false");
		expect(rows[0].textContent?.replace(/\s+/g, " ").trim()).toBe("edit deny");
		expect(screen.getByText(/overridden by/).elements()).toHaveLength(0);
	});

	it("scrolls inside the dialog shell, so a session with hundreds of rules cannot push past the viewport", async () => {
		const screen = mount({
			...RESULT,
			rules: Array.from({ length: 300 }, (_, i) => ({
				permission: `tool_${i}`,
				pattern: "*",
				action: "ask" as const,
			})),
		});
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		const dialog = screen.getByRole("dialog").element();
		expect(getComputedStyle(dialog).overflowY).toBe("auto");
		expect(dialog.scrollHeight).toBeGreaterThanOrEqual(dialog.clientHeight);
		expect(dialog.clientHeight).toBeLessThanOrEqual(window.innerHeight + 1);
	});

	it("has no free-form field: no text input, no select, and the only switches are the two coordination ones", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		const root = screen.getByTestId("permissions-detail").element();
		expect(root.querySelectorAll("input:not([type='checkbox']), select, textarea").length).toBe(0);
		expect([...root.querySelectorAll("[data-testid='coordination-options'] input")].length).toBe(2);
		expect([...root.querySelectorAll("button")].map((el) => el.getAttribute("aria-label"))).toEqual(
			["Remove exception for bash", "Remove exception for bash"]
		);
	});

	it("has no free-form rules editor, no Apply, and no word of auto-accept or a responder", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		const text = screen.getByRole("dialog").element().textContent ?? "";
		expect(text).not.toMatch(/auto-accept|responder|Apply to this session|Add rule/i);
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

	it("says exceptions last for this session, that Deny blocks them and that Ask restores them", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await expect
			.element(screen.getByText(/Exceptions last for this session only/))
			.toHaveTextContent(
				/Deny blocks them without deleting them; switching back to Ask restores them/
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
			sessionTitle: "Build it",
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
			sessionTitle: "Build it",
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
		const screen = mountGrant([]);
		await expect.element(screen.getByTestId("coordination-options")).toBeVisible();
	});

	it("a ceiling that caps a granted key is said under the switches", async () => {
		const screen = mountGrant(MESSAGE, {
			device: device({ policy: { permission: { max: { session_send: "ask" } } } }),
		});
		await expect.element(screen.getByText(/caps messaging sessions at Ask/)).toBeVisible();
	});
});
