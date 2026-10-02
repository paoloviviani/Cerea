import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { get } from "svelte/store";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentComposer from "./AgentComposer.svelte";
import { error as errorToast } from "$lib/stores/errors";
import type { CodeProviderFeature } from "$lib/codeApi";

/**
 * The Auto-accept toggle is opencode's own auto mode: a per-session responder
 * that answers tool asks "allow once". It never answers questions, never
 * overrides a deny, never saves an approval, and — what this file pins — it
 * writes no permission rule: flipping it makes exactly one call, the feature
 * flip, and touches nothing else in `codeApi`.
 */
const api = vi.hoisted(() => ({
	setAgentFeature: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
	getPermissionRules: vi.fn(async () => ({ rules: [], savedApprovals: [] })),
	removeSavedApproval: vi.fn(async () => ({ ok: true })),
	respondPermission: vi.fn(async () => ({ ok: true })),
}));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listAgentCommands: async () => ({ commands: [] }),
	...api,
}));

const DESCRIPTION =
	"Answers this session's tool asks with “allow once”. Never answers questions, never overrides a deny rule, never saves an approval. Subagents follow it unless they set their own.";

function feature(over: Partial<CodeProviderFeature> = {}): CodeProviderFeature {
	return {
		id: "auto_accept",
		label: "Auto-accept",
		description: DESCRIPTION,
		value: false,
		...over,
	};
}

function mount(features: CodeProviderFeature[]) {
	return renderWithApp(AgentComposer, {
		deviceId: "d1",
		agentId: "a1",
		agent: null,
		running: false,
		features,
		featureCatalog: features,
		onsend: async () => {},
		onstop: async () => true,
		onchanged: () => {},
	});
}

beforeEach(async () => {
	vi.clearAllMocks();
	errorToast.set(undefined);
	await browserPage.viewport(1200, 800);
});

describe("Auto-accept toggle", () => {
	it("says what it does on the pill, and what state it is in", async () => {
		const screen = mount([feature()]);
		const pill = screen.getByRole("button", { name: "Auto-accept" });
		await expect.element(pill).toBeVisible();
		const title = pill.element().getAttribute("title") ?? "";
		expect(title).toContain("allow once");
		expect(title).toContain("Never answers questions");
		expect(title).toContain("never overrides a deny");
		expect(title).toContain("never saves an approval");
		expect(title).toContain("Off. Click to turn on.");
		await expect.element(pill).toHaveAttribute("aria-pressed", "false");
	});

	it("never promises more than that", async () => {
		const screen = mount([feature({ value: true })]);
		const pill = screen.getByRole("button", { name: "Auto-accept" });
		const title = pill.element().getAttribute("title") ?? "";
		expect(title).toContain("On. Click to turn off.");
		expect(title).not.toMatch(/everything|all tools|full|unattended|bypass/i);
	});

	it("flips with one feature call and no other permission call at all", async () => {
		const screen = mount([feature()]);
		await screen.getByRole("button", { name: "Auto-accept" }).click();
		await vi.waitFor(() => expect(api.setAgentFeature).toHaveBeenCalledTimes(1));
		expect(api.setAgentFeature).toHaveBeenCalledWith("d1", "a1", "auto_accept", true);
		expect(api.getPermissionRules).not.toHaveBeenCalled();
		expect(api.removeSavedApproval).not.toHaveBeenCalled();
		expect(api.respondPermission).not.toHaveBeenCalled();
		await expect
			.element(screen.getByRole("button", { name: "Auto-accept" }))
			.toHaveAttribute("aria-pressed", "true");
	});

	it("rolls back, with the machine's words, when it refuses", async () => {
		api.setAgentFeature.mockRejectedValueOnce(new Error("The ceiling does not allow responders."));
		const screen = mount([feature()]);
		await screen.getByRole("button", { name: "Auto-accept" }).click();
		await vi.waitFor(() => expect(get(errorToast)).toBe("The ceiling does not allow responders."));
		await expect
			.element(screen.getByRole("button", { name: "Auto-accept" }))
			.toHaveAttribute("aria-pressed", "false");
	});

	it("is disabled, with the fix, when the machine's ceiling does not allow responders", async () => {
		const note =
			"This machine's permission ceiling does not let a responder answer asks: re-run `galopin enroll … --allow-auto-accept`, then restart `run`.";
		const screen = mount([feature({ blockedReason: note })]);
		const pill = screen.getByRole("button", { name: "Auto-accept" });
		await expect.element(pill).toBeDisabled();
		await expect.element(screen.getByText(note)).toBeVisible();
		expect(api.setAgentFeature).not.toHaveBeenCalled();
	});
});
