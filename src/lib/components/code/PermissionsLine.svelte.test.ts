import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { get } from "svelte/store";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import PermissionsLine from "./PermissionsLine.svelte";
import { error as errorToast } from "$lib/stores/errors";
import { flagCodeReauth, resetCodeReauth } from "$lib/stores/codeReauth.svelte";
import * as s from "$lib/components/overlay/styles";
import { codeLegacyMachines } from "$lib/stores/codeLegacyMachines.svelte";
import type { PermissionRulesResult } from "$lib/types/machineProtocol";

/**
 * The Permissions line is read-only: it shows what the machine says is in
 * force as one plain row per capability (the final answer, worked out from
 * the rules), the session's exceptions with Remove on each, and the raw rule
 * list behind a disclosure. The one write, removing an exception by id, goes through
 * `removeSavedApproval`; everything else arrives as the `result` prop, which
 * the parent view reads from `permission.rules`.
 *
 * MOCK: the rule lists below are the panel's reading of the frozen contract
 * with the agent half (feat/permission-selector-agent), not galopin's output.
 */
const fake = vi.hoisted(() => ({
	removed: [] as Array<{ agent: string; id: string }>,
	failRemove: null as string | null,
}));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => {
	const original = await importOriginal<typeof import("$lib/codeApi")>();
	return {
		...original,
		removeSavedApproval: async (_device: string, agent: string, id: string) => {
			if (fake.failRemove) throw new Error(fake.failRemove);
			fake.removed.push({ agent, id });
			return { ok: true };
		},
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
	result: PermissionRulesResult | null = RESULT,
	extra: { policy?: Record<string, unknown>; onreenroll?: () => void; onchanged?: () => void } = {}
) {
	return renderWithApp(PermissionsLine, {
		deviceId: "d1",
		agentId: "a1",
		result,
		...(extra as object),
	});
}

async function openDetail(screen: ReturnType<typeof mount>) {
	await screen.getByRole("button", { name: /Permissions/ }).click();
	await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
}

async function openRaw(screen: ReturnType<typeof mount>) {
	await openDetail(screen);
	await screen.getByText("Show the raw rules (for troubleshooting)").click();
	await expect.element(screen.getByTestId("permission-rules")).toBeVisible();
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
	await browserPage.viewport(1200, 800);
});

describe("Permissions line summary", () => {
	it("says the answer for edits, commands and web in plain words, with the exceptions counted", async () => {
		const screen = mount();
		// edit: Cerea's ask block replaces opencode's deny; bash: the ceiling's ask; webfetch: the machine's deny.
		await expect
			.element(screen.getByTestId("permission-summary"))
			.toHaveTextContent("Edits ask · commands ask · web blocked");
		await expect
			.element(screen.getByTestId("permission-exceptions-count"))
			.toHaveTextContent("3 exceptions");
	});

	it("falls back to the catch-all, and to ask when nothing matches", async () => {
		const allowed = mount({
			rules: [{ permission: "*", pattern: "*", action: "allow" }],
			savedApprovals: [],
			ceiling: {},
		});
		await expect
			.element(allowed.getByTestId("permission-summary"))
			.toHaveTextContent("Edits allowed · commands allowed · web allowed");

		const bare = mount({ rules: [], savedApprovals: [], ceiling: {} });
		await expect
			.element(bare.getByTestId("permission-summary").last())
			.toHaveTextContent("Edits ask · commands ask · web ask");
		expect(bare.getByTestId("permission-exceptions-count").elements()).toHaveLength(0);
	});

	it("says blocked for all three under Deny", async () => {
		const screen = mount({
			rules: [{ permission: "*", pattern: "*", action: "deny", source: "cerea" }],
			savedApprovals: [],
			ceiling: {},
		});
		await expect
			.element(screen.getByTestId("permission-summary"))
			.toHaveTextContent("Edits blocked · commands blocked · web blocked");
	});

	it("draws nothing without a reading (a machine that does not have the op)", async () => {
		const screen = mount(null);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByTestId("permissions-line").elements()).toHaveLength(0);
	});

	it("says '1 exception' in the singular", async () => {
		const screen = mount({
			rules: [],
			savedApprovals: [{ id: "ex_1", permission: "bash", patterns: ["ls"], removable: true }],
			ceiling: {},
		});
		await expect
			.element(screen.getByTestId("permission-exceptions-count"))
			.toHaveTextContent("1 exception");
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
		await openDetail(screen);
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
		await openDetail(screen);
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
		await openDetail(screen);
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
		await openDetail(screen);
		expect(rowText(screen, "bash")).toBe("Run commands Asks first limited by this machine");
		expect(rowText(screen, "edit")).toBe("Edit and write files Allowed");
		expect(screen.getByTestId("permission-capped").elements()).toHaveLength(1);
	});

	it("says what drives it, and keeps the raw rules closed until asked", async () => {
		const screen = mount();
		await openDetail(screen);
		await expect
			.element(screen.getByText(/Set by this session's Deny \/ Ask \/ Allow switch/))
			.toHaveTextContent("within the limits this machine was enrolled with");
		await expect.element(screen.getByTestId("permission-rules")).not.toBeVisible();
	});

	it("shows a rule Cerea's block replaces as overridden in the raw list, and an unreplaced one with its source", async () => {
		const screen = mount();
		await openRaw(screen);
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
		await openRaw(screen);
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
		await openRaw(screen);
		const rows = screen.getByTestId("permission-rule").elements();
		expect(rows).toHaveLength(2);
		expect(rows[0].getAttribute("data-overridden")).toBe("false");
		expect(rows[0].textContent?.replace(/\s+/g, " ").trim()).toBe("edit deny");
		expect(screen.getByText(/overridden by/).elements()).toHaveLength(0);
	});

	it("scrolls inside its own box, so a session with hundreds of rules cannot push the composer away", async () => {
		const screen = mount({
			...RESULT,
			rules: Array.from({ length: 300 }, (_, i) => ({
				permission: `tool_${i}`,
				pattern: "*",
				action: "ask" as const,
			})),
		});
		await openRaw(screen);
		const root = screen.getByTestId("permissions-detail").element();
		expect(root.scrollHeight).toBeGreaterThan(root.clientHeight);
		expect(root.clientHeight).toBeLessThanOrEqual(window.innerHeight * 0.4 + 1);
		expect(getComputedStyle(root).overflowY).toBe("auto");
	});

	it("is read-only: no field, no select, and the only buttons are the exceptions' Remove", async () => {
		const screen = mount();
		await openDetail(screen);
		const root = screen.getByTestId("permissions-detail").element();
		expect(root.querySelectorAll("input, select, textarea").length).toBe(0);
		expect([...root.querySelectorAll("button")].map((el) => el.getAttribute("aria-label"))).toEqual(
			["Remove exception for bash", "Remove exception for bash"]
		);
	});

	it("has no free-form rules editor, no Apply, and no word of auto-accept or a responder", async () => {
		const screen = mount();
		await openDetail(screen);
		const text = screen.getByTestId("permissions-line").element().textContent ?? "";
		expect(text).not.toMatch(/auto-accept|responder|Apply to this session|Add rule/i);
		expect(screen.getByTestId("permission-session-rules").elements()).toHaveLength(0);
	});
});

describe("the Exceptions list", () => {
	it("lists each exception with what it covers, Remove only where the machine will withdraw it", async () => {
		const screen = mount();
		await openDetail(screen);
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
		await openDetail(screen);
		await expect
			.element(screen.getByText(/Exceptions last for this session only/))
			.toHaveTextContent(
				/Deny blocks them without deleting them; switching back to Ask restores them/
			);
	});

	it("with none, says how one is made", async () => {
		const screen = mount({ rules: [], savedApprovals: [], ceiling: {} });
		await openDetail(screen);
		await expect.element(screen.getByText(/Always allow \(this session\)/)).toBeVisible();
	});

	it("removes an exception by id, then asks the parent to re-read", async () => {
		const onchanged = vi.fn();
		const screen = mount(RESULT, { onchanged });
		await openDetail(screen);
		await screen.getByRole("button", { name: "Remove exception for bash" }).first().click();

		await vi.waitFor(() => expect(fake.removed).toEqual([{ agent: "a1", id: "ex_1" }]));
		await vi.waitFor(() => expect(onchanged).toHaveBeenCalledTimes(1));
	});

	it("removes the second one by its own id", async () => {
		const screen = mount();
		await openDetail(screen);
		await screen.getByRole("button", { name: "Remove exception for bash" }).nth(1).click();
		await vi.waitFor(() => expect(fake.removed).toEqual([{ agent: "a1", id: "ex_2" }]));
	});

	it("keeps the list and says why when the machine refuses", async () => {
		fake.failRemove = "No such exception.";
		const onchanged = vi.fn();
		const screen = mount(RESULT, { onchanged });
		await openDetail(screen);
		await screen.getByRole("button", { name: "Remove exception for bash" }).first().click();

		await vi.waitFor(() => expect(get(errorToast)).toBe("No such exception."));
		expect(fake.removed).toEqual([]);
		expect(onchanged).not.toHaveBeenCalled();
		await expect
			.element(screen.getByTestId("permission-exceptions-count"))
			.toHaveTextContent("3 exceptions");
	});
});

describe("while the /code sign-in is stale", () => {
	it("the whole line goes, Remove with it", async () => {
		const screen = mount();
		await openDetail(screen);
		await expect
			.element(screen.getByRole("button", { name: "Remove exception for bash" }).first())
			.toBeVisible();

		flagCodeReauth();
		await vi.waitFor(() =>
			expect(screen.getByTestId("permissions-line").elements()).toHaveLength(0)
		);
		expect(screen.getByRole("button", { name: /Remove exception/ }).elements()).toHaveLength(0);
		expect(fake.removed).toEqual([]);
	});

	it("does not draw at all if the sign-in is already stale on arrival", async () => {
		flagCodeReauth();
		const screen = mount();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.getByTestId("permissions-line").elements()).toHaveLength(0);
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
		expect(screen.getByTestId("permissions-detail").elements()).toHaveLength(0);
		await screen.getByRole("button", { name: "Re-enroll this machine" }).click();
		expect(onreenroll).toHaveBeenCalledTimes(1);
		// Remembered for the machine's row in the tree.
		await vi.waitFor(() => expect(codeLegacyMachines.d1).toBe(true));
	});

	it("is not flagged for a properly enrolled machine", async () => {
		const screen = mount(RESULT, { policy: ENROLLED_POLICY });
		await expect.element(screen.getByTestId("permission-summary")).toBeVisible();
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
		await expect.element(screen.getByTestId("permission-summary")).toBeVisible();
		expect(screen.getByTestId("legacy-machine-flag").elements()).toHaveLength(0);
	});

	it("clears when a re-enroll gives the machine a ceiling", async () => {
		const screen = mount(ALLOW_ALL, { policy: LEGACY_POLICY });
		await expect.element(screen.getByTestId("legacy-machine-flag")).toBeVisible();
		await screen.rerender({
			deviceId: "d1",
			agentId: "a1",
			result: {
				rules: [
					{ permission: "*", pattern: "*", action: "allow", source: "opencode" },
					{ permission: "bash", pattern: "*", action: "ask", source: "ceiling" },
				],
				savedApprovals: [],
				ceiling: { bash: "ask" },
			},
			policy: ENROLLED_POLICY,
		});
		await vi.waitFor(() =>
			expect(screen.getByTestId("legacy-machine-flag").elements()).toHaveLength(0)
		);
		await vi.waitFor(() => expect(codeLegacyMachines.d1).toBe(false));
	});
});
