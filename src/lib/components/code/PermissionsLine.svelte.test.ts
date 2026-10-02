import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { get } from "svelte/store";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import PermissionsLine from "./PermissionsLine.svelte";
import { error as errorToast } from "$lib/stores/errors";
import type { PermissionRulesResult } from "$lib/types/machineProtocol";

/**
 * The Permissions line is a READ of opencode's rules plus the one tightening
 * write (forget a saved approval). The machine is a fake: `fake.rules` is
 * what `permission.rules` would answer, in the contract's shape — MOCK, the
 * agent half has not landed.
 */
const fake = vi.hoisted(() => ({
	rules: null as unknown,
	reads: 0,
	removed: [] as string[],
	failRemove: null as string | null,
	failRead: null as number | null,
}));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => {
	const original = await importOriginal<typeof import("$lib/codeApi")>();
	return {
		...original,
		getPermissionRules: async () => {
			fake.reads += 1;
			if (fake.failRead !== null) throw new original.CodeApiError("nope", fake.failRead);
			return structuredClone(fake.rules) as PermissionRulesResult;
		},
		removeSavedApproval: async (_device: string, _agent: string, id: string) => {
			if (fake.failRemove) throw new Error(fake.failRemove);
			fake.removed.push(id);
			const state = fake.rules as PermissionRulesResult;
			state.savedApprovals = state.savedApprovals.filter((approval) => approval.id !== id);
			return { ok: true };
		},
	};
});

const RULES: PermissionRulesResult = {
	rules: [
		{ permission: "*", pattern: "*", action: "allow", source: "default" },
		{ permission: "edit", pattern: "*", action: "deny", source: "file" },
		{ permission: "edit", pattern: "*", action: "ask", source: "cerea" },
		{ permission: "bash", pattern: "*", action: "ask", source: "ceiling" },
		{ permission: "bash", pattern: "git *", action: "allow", source: "file" },
		{ permission: "webfetch", pattern: "*", action: "deny", source: "cerea" },
	],
	savedApprovals: [
		{ id: "sa-1", permission: "bash", patterns: ["npm test"] },
		{ id: "sa-2", permission: "edit", patterns: ["src/**"] },
	],
};

function mount(refreshKey = 0) {
	return renderWithApp(PermissionsLine, { deviceId: "d1", agentId: "a1", refreshKey });
}

beforeEach(async () => {
	fake.rules = structuredClone(RULES);
	fake.reads = 0;
	fake.removed = [];
	fake.failRemove = null;
	fake.failRead = null;
	errorToast.set(undefined);
	await browserPage.viewport(1200, 800);
});

describe("Permissions line summary", () => {
	it("reads the last matching rule for edit, bash and webfetch", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permission-edit")).toHaveTextContent("edit ask");
		// bash: the catch-all is the ceiling's ask, with one narrower rule noted.
		await expect.element(screen.getByTestId("permission-bash")).toHaveTextContent("bash ask +1");
		await expect
			.element(screen.getByTestId("permission-webfetch"))
			.toHaveTextContent("webfetch deny");
		await expect.element(screen.getByTestId("permission-saved-count")).toHaveTextContent("2 saved");
	});

	it("falls back to the catch-all, and to ask when nothing matches", async () => {
		fake.rules = {
			rules: [{ permission: "*", pattern: "*", action: "allow" }],
			savedApprovals: [],
		};
		const allowed = mount();
		await expect.element(allowed.getByTestId("permission-edit")).toHaveTextContent("edit allow");
		await expect.element(allowed.getByTestId("permission-bash")).toHaveTextContent("bash allow");

		fake.rules = { rules: [], savedApprovals: [] };
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
	it("shows a file rule Cerea replaces as overridden, and an unreplaced one as the person's own", async () => {
		const screen = mount();
		await screen.getByRole("button", { name: /Permissions/ }).click();
		const rows = screen.getByTestId("permission-rule");
		await expect.element(rows.nth(0)).toBeVisible();

		const overridden = screen.getByText("overridden by Cerea");
		await expect.element(overridden).toBeVisible();
		// Exactly one: the file `edit: deny` that Cerea's `edit: ask` replaces.
		expect(overridden.elements()).toHaveLength(1);
		const struck = screen
			.getByTestId("permission-rule")
			.elements()
			.filter((el) => el.getAttribute("data-overridden") === "true");
		expect(struck).toHaveLength(1);
		expect(struck[0].textContent).toContain("edit");
		expect(struck[0].textContent).toContain("deny");

		// `bash git *: allow` is the person's and nothing later covers it.
		const gitRule = screen
			.getByTestId("permission-rule")
			.elements()
			.find((el) => el.textContent?.includes("git *"));
		expect(gitRule?.getAttribute("data-overridden")).toBe("false");
		expect(gitRule?.textContent).toContain("your opencode config");
	});

	it("names the ceiling when the machine's own limits replace a file rule", async () => {
		fake.rules = {
			rules: [
				{ permission: "bash", pattern: "*", action: "allow", source: "file" },
				{ permission: "bash", pattern: "*", action: "deny", source: "ceiling" },
			],
			savedApprovals: [],
		};
		const screen = mount();
		await screen.getByRole("button", { name: /Permissions/ }).click();
		await expect.element(screen.getByText("overridden by this machine's limits")).toBeVisible();
	});

	it("offers no control that writes a rule: only Remove, on saved approvals", async () => {
		const screen = mount();
		await screen.getByRole("button", { name: /Permissions/ }).click();
		const detail = screen.getByTestId("permissions-detail");
		await expect.element(detail).toBeVisible();
		const root = detail.element();
		expect(root.querySelectorAll("input, select, textarea, [contenteditable]")).toHaveLength(0);
		const buttons = [...root.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
		expect(buttons).toEqual(["Remove saved approval for bash", "Remove saved approval for edit"]);
		expect(root.textContent?.replace(/\s+/g, " ")).toContain("cannot change a rule");
	});
});

describe("removing a saved approval", () => {
	it("forgets it on the machine, then redraws from the machine's answer", async () => {
		const screen = mount();
		await screen.getByRole("button", { name: /Permissions/ }).click();
		await screen.getByRole("button", { name: "Remove saved approval for bash" }).click();

		await vi.waitFor(() => expect(fake.removed).toEqual(["sa-1"]));
		await expect.element(screen.getByTestId("permission-saved-count")).toHaveTextContent("1 saved");
		expect(
			screen.getByRole("button", { name: "Remove saved approval for bash" }).elements()
		).toHaveLength(0);
		await expect
			.element(screen.getByRole("button", { name: "Remove saved approval for edit" }))
			.toBeVisible();
		// Two reads: the first draw and the redraw after the removal.
		expect(fake.reads).toBe(2);
	});

	it("keeps the approval and says why when the machine refuses", async () => {
		fake.failRemove = "No such saved approval.";
		const screen = mount();
		await screen.getByRole("button", { name: /Permissions/ }).click();
		await screen.getByRole("button", { name: "Remove saved approval for bash" }).click();

		await vi.waitFor(() => expect(get(errorToast)).toBe("No such saved approval."));
		expect(fake.removed).toEqual([]);
		await expect.element(screen.getByTestId("permission-saved-count")).toHaveTextContent("2 saved");
	});
});
