import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { get } from "svelte/store";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import PermissionsLine from "./PermissionsLine.svelte";
import { error as errorToast } from "$lib/stores/errors";
import type { PermissionRulesResult, SessionRuleInput } from "$lib/types/machineProtocol";

/**
 * The Permissions line shows what the machine says is in force and lets the
 * person set THIS session's rules. The machine is a fake: `fake.state` is what
 * `permission.rules` answers, `setSessionRules` applies the ceiling the way the
 * contract says the machine does — MOCK, the agent half is being built
 * concurrently and none of this is galopin's behaviour.
 */
const fake = vi.hoisted(() => ({
	state: null as unknown,
	/** The ceiling the machine enforces on a write; can be stricter than the
	 * one it last REPORTED (that is the case the line must stay honest about). */
	enforced: {} as Record<string, "ask" | "deny">,
	reads: 0,
	removed: [] as string[],
	writes: [] as unknown[],
	failRemove: null as string | null,
	failRead: null as number | null,
	failWrite: null as string | null,
}));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => {
	const original = await importOriginal<typeof import("$lib/codeApi")>();
	const RANK = { deny: 0, ask: 1, allow: 2 } as const;
	return {
		...original,
		getPermissionRules: async () => {
			fake.reads += 1;
			if (fake.failRead !== null) throw new original.CodeApiError("nope", fake.failRead);
			return structuredClone(fake.state) as PermissionRulesResult;
		},
		setSessionRules: async (_device: string, _agent: string, rules: SessionRuleInput[]) => {
			fake.writes.push(structuredClone(rules));
			if (fake.failWrite) throw new original.CodeApiError(fake.failWrite, 403);
			const state = fake.state as PermissionRulesResult;
			const applied = rules.map((rule) => {
				const max = fake.enforced[rule.permission];
				return max && RANK[rule.action] > RANK[max] ? { ...rule, action: max } : rule;
			});
			state.rules = [
				...state.rules.filter((rule) => rule.source !== "cerea"),
				...applied.map((rule) => ({ ...rule, source: "cerea" })),
			];
			return { ok: true };
		},
		removeSavedApproval: async (_device: string, _agent: string, id: string) => {
			if (fake.failRemove) throw new Error(fake.failRemove);
			fake.removed.push(id);
			const state = fake.state as PermissionRulesResult;
			state.savedApprovals = state.savedApprovals.filter((approval) => approval.id !== id);
			return { ok: true };
		},
	};
});

const RULES: PermissionRulesResult = {
	rules: [
		{ permission: "*", pattern: "*", action: "allow", source: "opencode" },
		{ permission: "edit", pattern: "*", action: "deny", source: "opencode" },
		{ permission: "edit", pattern: "*", action: "ask", source: "cerea" },
		{ permission: "bash", pattern: "*", action: "ask", source: "ceiling" },
		{ permission: "bash", pattern: "git *", action: "allow", source: "opencode" },
		{ permission: "webfetch", pattern: "*", action: "deny", source: "machine" },
	],
	savedApprovals: [
		{ id: "sa-1", permission: "bash", patterns: ["npm test"] },
		{ id: "sa-2", permission: "bash", patterns: ["ls"] },
		{ id: "sa-3", permission: "edit", patterns: ["src/**"], removable: false },
	],
	ceiling: { bash: "ask" },
};

function mount(refreshKey = 0) {
	return renderWithApp(PermissionsLine, { deviceId: "d1", agentId: "a1", refreshKey });
}

async function openDetail(screen: ReturnType<typeof mount>) {
	await screen.getByRole("button", { name: /Permissions/ }).click();
	await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
}

beforeEach(async () => {
	fake.state = structuredClone(RULES);
	fake.enforced = { bash: "ask" };
	fake.reads = 0;
	fake.removed = [];
	fake.writes = [];
	fake.failRemove = null;
	fake.failRead = null;
	fake.failWrite = null;
	errorToast.set(undefined);
	await browserPage.viewport(1200, 800);
});

describe("Permissions line summary", () => {
	it("reads the last matching rule for edit, bash and webfetch, with saved approvals on each pill", async () => {
		const screen = mount();
		await expect
			.element(screen.getByTestId("permission-edit"))
			.toHaveTextContent("edit ask · 1 saved");
		// bash: the ceiling's ask is the catch-all, one narrower rule noted, two saved.
		await expect
			.element(screen.getByTestId("permission-bash"))
			.toHaveTextContent("bash ask +1 · 2 saved");
		await expect
			.element(screen.getByTestId("permission-webfetch"))
			.toHaveTextContent("webfetch deny");
		expect(screen.getByTestId("permission-webfetch").element().textContent).not.toContain("saved");
		await expect.element(screen.getByTestId("permission-saved-count")).toHaveTextContent("3 saved");
	});

	it("falls back to the catch-all, and to ask when nothing matches", async () => {
		fake.state = {
			rules: [{ permission: "*", pattern: "*", action: "allow" }],
			savedApprovals: [],
			ceiling: {},
		};
		const allowed = mount();
		await expect.element(allowed.getByTestId("permission-edit")).toHaveTextContent("edit allow");
		await expect.element(allowed.getByTestId("permission-bash")).toHaveTextContent("bash allow");

		fake.state = { rules: [], savedApprovals: [], ceiling: {} };
		const bare = mount();
		await expect
			.element(bare.getByTestId("permission-webfetch").last())
			.toHaveTextContent("webfetch ask");
		expect(bare.getByTestId("permission-saved-count").elements()).toHaveLength(0);
	});

	it("draws nothing on a machine that does not have the op", async () => {
		fake.failRead = 404;
		const screen = mount();
		await vi.waitFor(() => expect(fake.reads).toBe(1));
		expect(screen.getByTestId("permissions-line").elements()).toHaveLength(0);
	});

	it("keeps the last reading when a later read fails", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permission-edit")).toBeVisible();
		fake.failRead = 502;
		await screen.rerender({ deviceId: "d1", agentId: "a1", refreshKey: 1 });
		await vi.waitFor(() => expect(fake.reads).toBe(2));
		await expect.element(screen.getByTestId("permission-edit")).toBeVisible();
	});

	it("re-reads when the parent bumps the key", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permission-edit")).toBeVisible();
		expect(fake.reads).toBe(1);
		await screen.rerender({ deviceId: "d1", agentId: "a1", refreshKey: 1 });
		await vi.waitFor(() => expect(fake.reads).toBe(2));
	});
});

describe("Permissions line detail", () => {
	it("shows a rule Cerea replaces as overridden, and an unreplaced one with its source", async () => {
		const screen = mount();
		await openDetail(screen);
		const overridden = screen.getByText("overridden by Cerea");
		await expect.element(overridden).toBeVisible();
		// Exactly one: opencode's `edit: deny` that Cerea's `edit: ask` replaces.
		expect(overridden.elements()).toHaveLength(1);
		const rows = screen.getByTestId("permission-rule").elements();
		const struck = rows.filter((el) => el.getAttribute("data-overridden") === "true");
		expect(struck).toHaveLength(1);
		expect(struck[0].textContent).toContain("edit");
		expect(struck[0].textContent).toContain("deny");
		// `bash git *: allow` is opencode's and nothing later covers it.
		const gitRule = rows.find((el) => el.textContent?.includes("git *"));
		expect(gitRule?.getAttribute("data-overridden")).toBe("false");
		expect(gitRule?.textContent).toContain("opencode's rules");
	});

	it("names the machine's floor and its limits when they replace a rule", async () => {
		fake.state = {
			rules: [
				{ permission: "bash", pattern: "*", action: "allow", source: "opencode" },
				{ permission: "bash", pattern: "*", action: "ask", source: "floor" },
				{ permission: "edit", pattern: "*", action: "allow", source: "opencode" },
				{ permission: "edit", pattern: "*", action: "deny", source: "ceiling" },
			],
			savedApprovals: [],
			ceiling: {},
		};
		const screen = mount();
		await openDetail(screen);
		await expect.element(screen.getByText("overridden by this machine's floor")).toBeVisible();
		await expect.element(screen.getByText("overridden by this machine's limits")).toBeVisible();
	});

	it("shows a rule with no source plainly: no label, never overridden", async () => {
		fake.state = {
			rules: [
				{ permission: "edit", pattern: "*", action: "deny" },
				{ permission: "edit", pattern: "*", action: "allow", source: "cerea" },
			],
			savedApprovals: [],
			ceiling: {},
		};
		const screen = mount();
		await openDetail(screen);
		const rows = screen.getByTestId("permission-rule").elements();
		expect(rows).toHaveLength(2);
		expect(rows[0].getAttribute("data-overridden")).toBe("false");
		expect(rows[0].textContent?.replace(/\s+/g, " ").trim()).toBe("edit deny");
		expect(screen.getByText(/overridden by/).elements()).toHaveLength(0);
	});

	it("offers Remove only on approvals the machine will withdraw", async () => {
		const screen = mount();
		await openDetail(screen);
		await expect
			.element(screen.getByRole("button", { name: "Remove saved approval for bash" }).first())
			.toBeVisible();
		expect(
			screen.getByRole("button", { name: "Remove saved approval for edit" }).elements()
		).toHaveLength(0);
		await expect.element(screen.getByText("held by opencode")).toBeVisible();
	});
});

describe("this session's rules", () => {
	it("starts from the rules Cerea has in force, and says what the machine caps", async () => {
		const screen = mount();
		await openDetail(screen);
		const rows = screen.getByTestId("session-rule-row").elements();
		expect(rows).toHaveLength(1);
		await expect.element(screen.getByLabelText("Permission for rule 1")).toHaveValue("edit");
		await expect
			.element(screen.getByTestId("permission-ceiling"))
			.toHaveTextContent("bash at most ask");
		await expect
			.element(screen.getByRole("button", { name: "Apply to this session" }))
			.toBeDisabled();
	});

	it("offers no action above the ceiling for a capped permission", async () => {
		const screen = mount();
		await openDetail(screen);
		await screen.getByRole("button", { name: "Add rule" }).click();
		await screen.getByLabelText("Permission for rule 2").fill("bash");
		const options = (el: Element) =>
			[...el.querySelectorAll("option")].filter((o) => !o.disabled).map((o) => o.value);
		expect(options(screen.getByLabelText("Action for rule 2").element())).toEqual(["ask", "deny"]);
		// An uncapped permission keeps all three.
		expect(options(screen.getByLabelText("Action for rule 1").element())).toEqual([
			"allow",
			"ask",
			"deny",
		]);
	});

	it("refuses to send a rule moved above the ceiling, and says why", async () => {
		const screen = mount();
		await openDetail(screen);
		await screen.getByLabelText("Action for rule 1").selectOptions("allow");
		await expect
			.element(screen.getByRole("button", { name: "Apply to this session" }))
			.toBeEnabled();
		await screen.getByLabelText("Permission for rule 1").fill("bash");
		await expect
			.element(screen.getByTestId("session-rule-problem"))
			.toHaveTextContent('bash may be at most "ask"');
		await expect
			.element(screen.getByRole("button", { name: "Apply to this session" }))
			.toBeDisabled();
		expect(fake.writes).toEqual([]);
	});

	it("sends exactly the rows, then shows what the re-read says is in force", async () => {
		const screen = mount();
		await openDetail(screen);
		await screen.getByRole("button", { name: "Add rule" }).click();
		await screen.getByLabelText("Permission for rule 2").fill("webfetch");
		await screen.getByLabelText("Pattern for rule 2").fill("https://example.com/*");
		await screen.getByLabelText("Action for rule 2").selectOptions("allow");
		await screen.getByRole("button", { name: "Apply to this session" }).click();

		await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
		expect(fake.writes[0]).toEqual([
			{ permission: "edit", pattern: "*", action: "ask" },
			{ permission: "webfetch", pattern: "https://example.com/*", action: "allow" },
		]);
		await expect.element(screen.getByTestId("session-rules-outcome")).toHaveTextContent("Applied");
		// Re-read after the write: the summary now carries what is in force.
		expect(fake.reads).toBeGreaterThanOrEqual(2);
		await expect
			.element(screen.getByTestId("permission-rules"))
			.toHaveTextContent("https://example.com/*");
		await expect
			.element(screen.getByRole("button", { name: "Apply to this session" }))
			.toBeDisabled();
	});

	it("shows what is in force, not what was asked, when the machine lowers a rule", async () => {
		// The panel last heard of no cap on webfetch; the machine enforces one.
		fake.enforced = { bash: "ask", webfetch: "deny" };
		const screen = mount();
		await openDetail(screen);
		await screen.getByRole("button", { name: "Add rule" }).click();
		await screen.getByLabelText("Permission for rule 2").fill("webfetch");
		await screen.getByLabelText("Action for rule 2").selectOptions("allow");
		await screen.getByRole("button", { name: "Apply to this session" }).click();

		const outcome = screen.getByTestId("session-rules-outcome");
		await expect.element(outcome).toHaveTextContent("Not applied as asked");
		await expect.element(outcome).toHaveTextContent("webfetch * is deny, not allow");
		// The editor's row, the list and the summary all say deny.
		await expect.element(screen.getByLabelText("Action for rule 2")).toHaveValue("deny");
		await expect
			.element(screen.getByTestId("permission-webfetch"))
			.toHaveTextContent("webfetch deny");
		const cereaWebfetch = screen
			.getByTestId("permission-rule")
			.elements()
			.filter((el) => el.textContent?.includes("webfetch") && el.textContent?.includes("Cerea"));
		expect(cereaWebfetch).toHaveLength(1);
		expect(cereaWebfetch[0].textContent).toContain("deny");
		expect(cereaWebfetch[0].textContent).not.toContain("allow");
	});

	it("keeps the row, shows the machine's words and the unchanged truth when it refuses", async () => {
		fake.failWrite = "webfetch may not exceed deny on this machine.";
		const screen = mount();
		await openDetail(screen);
		await screen.getByRole("button", { name: "Add rule" }).click();
		await screen.getByLabelText("Permission for rule 2").fill("webfetch");
		await screen.getByLabelText("Action for rule 2").selectOptions("allow");
		await screen.getByRole("button", { name: "Apply to this session" }).click();

		await vi.waitFor(() =>
			expect(get(errorToast)).toBe("webfetch may not exceed deny on this machine.")
		);
		await expect
			.element(screen.getByTestId("session-rules-outcome"))
			.toHaveTextContent("Nothing was applied");
		// The row stays for the person to fix; the list above is still the truth.
		await expect.element(screen.getByLabelText("Permission for rule 2")).toHaveValue("webfetch");
		await expect
			.element(screen.getByTestId("permission-webfetch"))
			.toHaveTextContent("webfetch deny");
		expect(fake.reads).toBeGreaterThanOrEqual(2);
	});

	it("discards an edit and returns to what is in force", async () => {
		const screen = mount();
		await openDetail(screen);
		await screen.getByRole("button", { name: "Add rule" }).click();
		expect(screen.getByTestId("session-rule-row").elements()).toHaveLength(2);
		await screen.getByRole("button", { name: "Discard" }).click();
		expect(screen.getByTestId("session-rule-row").elements()).toHaveLength(1);
		expect(fake.writes).toEqual([]);
	});

	it("a re-read in the middle of an edit does not throw the edit away", async () => {
		const screen = mount();
		await openDetail(screen);
		await screen.getByRole("button", { name: "Add rule" }).click();
		await screen.rerender({ deviceId: "d1", agentId: "a1", refreshKey: 1 });
		await vi.waitFor(() => expect(fake.reads).toBe(2));
		expect(screen.getByTestId("session-rule-row").elements()).toHaveLength(2);
	});

	it("has no control for the ceiling, the machine's rules or policy: only the session editor and Remove", async () => {
		const screen = mount();
		await openDetail(screen);
		const root = screen.getByTestId("permissions-detail").element();
		const editor = screen.getByTestId("permission-session-rules").element();
		const outside = [...root.querySelectorAll("input, select, textarea, button")].filter(
			(el) => !editor.contains(el)
		);
		expect(outside.map((el) => el.getAttribute("aria-label"))).toEqual([
			"Remove saved approval for bash",
			"Remove saved approval for bash",
		]);
	});
});

describe("removing a saved approval", () => {
	it("forgets it on the machine, then redraws from the machine's answer", async () => {
		const screen = mount();
		await openDetail(screen);
		await screen.getByRole("button", { name: "Remove saved approval for bash" }).first().click();

		await vi.waitFor(() => expect(fake.removed).toEqual(["sa-1"]));
		await expect.element(screen.getByTestId("permission-saved-count")).toHaveTextContent("2 saved");
		await expect.element(screen.getByTestId("permission-bash")).toHaveTextContent("1 saved");
		// Two reads: the first draw and the redraw after the removal.
		expect(fake.reads).toBe(2);
	});

	it("keeps the approval and says why when the machine refuses", async () => {
		fake.failRemove = "No such saved approval.";
		const screen = mount();
		await openDetail(screen);
		await screen.getByRole("button", { name: "Remove saved approval for bash" }).first().click();

		await vi.waitFor(() => expect(get(errorToast)).toBe("No such saved approval."));
		expect(fake.removed).toEqual([]);
		await expect.element(screen.getByTestId("permission-saved-count")).toHaveTextContent("3 saved");
	});
});
