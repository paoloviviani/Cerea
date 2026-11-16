import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { get } from "svelte/store";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import PermissionsDialog from "./PermissionsDialog.svelte";
import { error as errorToast } from "$lib/stores/errors";
import { flagCodeReauth, resetCodeReauth } from "$lib/stores/codeReauth.svelte";
import { CodeApiError } from "$lib/codeApi";
import type { PermissionRulesResult } from "$lib/types/machineProtocol";

/**
 * The Permissions sheet shows what reaches the user on the machine, class by class (ADR 0107),
 * and the session's exceptions with Remove on each. It reads the session's
 * `permission.rules` itself — that is what lets a session's ⋯ menu open it
 * for a row that is not the selection — and re-reads after the one write,
 * removing an exception by id through `removeSavedApproval`.
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
	getSessionConnectors: vi.fn(),
	setSessionConnectors: vi.fn(),
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
		getSessionConnectors: api.getSessionConnectors,
		setSessionConnectors: api.setSessionConnectors,
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
		mode?: "deny" | "ask" | "auto" | "allow";
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
	fake.removed = [];
	fake.failRemove = null;
	errorToast.set(undefined);
	api.getPermissionRules.mockReset().mockResolvedValue(RESULT);
	api.getAutoApproval.mockReset().mockRejectedValue(new Error("none"));
	api.getSessionConnectors.mockReset().mockResolvedValue({ options: [], selected: [] });
	api.setSessionConnectors.mockReset().mockResolvedValue({ selected: [] });
	api.removeSavedApproval
		.mockReset()
		.mockImplementation(async (_device: string, agent: string, id: string) => {
			if (fake.failRemove) throw new Error(fake.failRemove);
			fake.removed.push({ agent, id });
			return { ok: true };
		});
	await browserPage.viewport(1200, 800);
});

// The user's own rows (ADR 0109): edits, web, agents and tools run; commands and outside access
// go to the reviewer; secrets come to the user.
const PER_CLASS = {
	edit: "run",
	command: "reviewer",
	web: "run",
	outside: "reviewer",
	secrets: "you",
	agents: "run",
	tools: "run",
	loop: "you",
} as const;
const policyOf = () => ({ workspaceRoots: [], allowFreeModels: false }) as never;
const deviceOf = (policy: unknown) =>
	({ id: "d1", name: "studio-laptop", backends: [], policy }) as never;
const cell = (screen: ReturnType<typeof mount>, kind: "outcome" | "reason", c: string) =>
	screen.getByTestId(`permission-${kind}-${c}`);

describe("the Permissions sheet: what reaches you", () => {
	const reviewer = { reviewerAvailable: true, perClass: PER_CLASS };

	it("is titled with the machine and says what reaches you on Auto, with a row and a reason per class", async () => {
		const screen = mount(RESULT, {
			mode: "auto",
			setup: reviewer,
			device: deviceOf(policyOf()),
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
		await expect
			.element(cell(screen, "reason", "edit"))
			.toHaveTextContent("Set in Workspace, Agents");
		await expect.element(cell(screen, "outcome", "command")).toHaveTextContent("Reviewed");
		await expect.element(cell(screen, "outcome", "secrets")).toHaveTextContent("Comes to you");
		await expect.element(cell(screen, "reason", "loop")).toHaveTextContent("Always comes to you");
		// Rows are runs / reviewed / comes to you: no machine limit anywhere.
		expect(document.body.textContent).not.toMatch(/this machine's limit|older galopin|Refused/i);
		await expect
			.element(screen.getByTestId("permission-agents-link"))
			.toHaveAttribute("href", "/workspace?tab=agents");
	});

	it("says what Plan, Ask and Allow mean in one sentence; the class rows are for Auto only", async () => {
		let screen = mount(RESULT, { mode: "deny", setup: reviewer });
		await expect.element(screen.getByTestId("permission-step")).toHaveTextContent("Plan:");
		document.body.innerHTML = "";
		screen = mount(RESULT, { mode: "ask", setup: reviewer });
		await expect.element(screen.getByTestId("permission-step")).toHaveTextContent("Ask:");
		document.body.innerHTML = "";
		screen = mount(RESULT, { mode: "allow", setup: reviewer });
		await expect.element(screen.getByTestId("permission-step")).toHaveTextContent("hands off");
		expect(screen.getByTestId("permission-classes").elements()).toHaveLength(0);
	});

	it("a class set to runs runs, one set to you comes to you", async () => {
		const screen = mount(RESULT, {
			mode: "auto",
			setup: { reviewerAvailable: true, perClass: { ...PER_CLASS, command: "run", edit: "you" } },
		});
		await expect.element(cell(screen, "outcome", "command")).toHaveTextContent("Runs");
		await expect.element(cell(screen, "outcome", "edit")).toHaveTextContent("Comes to you");
	});

	it("with no reviewer, a reviewer row comes to you, never runs; what runs still runs", async () => {
		const screen = mount(RESULT, {
			mode: "auto",
			setup: { reviewerAvailable: false, perClass: PER_CLASS },
			device: deviceOf(policyOf()),
		});
		await expect.element(cell(screen, "outcome", "command")).toHaveTextContent("Comes to you");
		await expect
			.element(cell(screen, "reason", "command"))
			.toHaveTextContent("No reviewer is switched on for you");
		await expect.element(cell(screen, "outcome", "edit")).toHaveTextContent("Runs");
	});

	it("reads the reviewer's availability itself when the opener has none", async () => {
		api.getAutoApproval.mockResolvedValue({ available: true, perClass: PER_CLASS });
		const screen = mount(RESULT, { mode: "auto", device: deviceOf(policyOf()) });
		await expect.element(cell(screen, "outcome", "command")).toHaveTextContent("Reviewed");
	});

	it("shows nothing of the backend: no tool names, no rule list, no raw rules", async () => {
		const screen = mount(RESULT, { mode: "auto", setup: reviewer });
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
			"Allowed for this session: src/** (edit) held by the computer",
		]);
		await expect.element(screen.getByText("held by the computer")).toBeVisible();
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

describe("Permissions dialog: no Coordination section", () => {
	it("has no coordination switches, notes or labels: the Agents row governs it", async () => {
		for (const mode of ["ask", "auto", "allow", "deny"] as const) {
			document.body.innerHTML = "";
			const screen = mount(RESULT, { mode });
			await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
			expect(document.querySelector('[data-testid="coordination-options"]')).toBeNull();
			expect(document.querySelector('[data-testid="coordination-note"]')).toBeNull();
			expect(document.body.textContent).not.toContain("Can find, read and message");
			expect(document.body.textContent).not.toContain("Can start new sessions");
		}
	});
});
