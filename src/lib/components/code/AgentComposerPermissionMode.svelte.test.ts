import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentComposer from "./AgentComposer.svelte";
import { flagCodeReauth, resetCodeReauth } from "$lib/stores/codeReauth.svelte";
import type { CodeAgentSession } from "$lib/types/CodeAgent";

/**
 * The permission selector, Deny · Ask · Allow: the session's blanket until
 * changed. What this file pins:
 * - it shows the machine's word (`agent.permissionMode`) and never a guess:
 *   a click sends one op and the segment moves only when the snapshot does;
 * - under Allow it names what the ceiling still caps;
 * - on a subagent it is disabled, saying it follows the main session;
 * - it is absent without a word to show (an older machine) and while the
 *   sign-in is stale;
 * - it writes no rule: the one call is `setPermissionMode`.
 *
 * MOCK: `permissionMode` and the ceiling are the panel's reading of the frozen
 * contract with the agent half (feat/permission-selector-agent).
 */
const api = vi.hoisted(() => ({
	setPermissionMode: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
	getPermissionRules: vi.fn(async () => ({ rules: [], savedApprovals: [], ceiling: {} })),
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

function session(over: Partial<CodeAgentSession> = {}): CodeAgentSession {
	return {
		id: "a1",
		workspaceId: "w1",
		title: "Build it",
		provider: "opencode",
		state: "idle",
		updatedAt: "2026-10-03T00:00:00Z",
		modeId: null,
		modelId: null,
		permissionMode: "ask",
		...over,
	};
}

function mount(
	agent: CodeAgentSession | null,
	extra: {
		ceiling?: Record<string, "ask" | "deny">;
		onchanged?: () => void;
		onpermissionchanged?: () => void;
	} = {}
) {
	return renderWithApp(AgentComposer, {
		deviceId: "d1",
		agentId: "a1",
		agent,
		running: false,
		onsend: async () => {},
		onstop: async () => true,
		onchanged: () => {},
		...extra,
	});
}

const segment = (screen: ReturnType<typeof mount>, mode: string) =>
	screen.getByTestId(`permission-mode-${mode}`);

beforeEach(async () => {
	vi.clearAllMocks();
	resetCodeReauth();
	await browserPage.viewport(1200, 800);
});

describe("the permission selector", () => {
	it("is three segments, Deny · Ask · Allow, with the machine's word selected", async () => {
		const screen = mount(session({ permissionMode: "allow" }));
		const group = screen.getByRole("radiogroup", { name: "Permission for this session" });
		await expect.element(group).toBeVisible();
		const radios = group.getByRole("radio").elements();
		expect(radios.map((el) => el.textContent?.trim())).toEqual(["Deny", "Ask", "Allow"]);
		await expect.element(segment(screen, "allow")).toHaveAttribute("aria-checked", "true");
		await expect.element(segment(screen, "ask")).toHaveAttribute("aria-checked", "false");
		await expect.element(segment(screen, "deny")).toHaveAttribute("aria-checked", "false");
	});

	for (const mode of ["deny", "ask", "allow"] as const) {
		it(`shows ${mode} when that is the machine's word, and only that`, async () => {
			const screen = mount(session({ permissionMode: mode }));
			await expect.element(segment(screen, mode)).toHaveAttribute("aria-checked", "true");
			for (const other of (["deny", "ask", "allow"] as const).filter((m) => m !== mode)) {
				await expect.element(segment(screen, other)).toHaveAttribute("aria-checked", "false");
			}
		});
	}

	it("sends one op and nothing else, and does not move until the snapshot does", async () => {
		const onpermissionchanged = vi.fn();
		const screen = mount(session({ permissionMode: "ask" }), { onpermissionchanged });
		await segment(screen, "deny").click();
		await vi.waitFor(() => expect(api.setPermissionMode).toHaveBeenCalledTimes(1));
		expect(api.setPermissionMode).toHaveBeenCalledWith("d1", "a1", "deny");
		await vi.waitFor(() => expect(onpermissionchanged).toHaveBeenCalledTimes(1));
		// The parent has not re-read: the machine's word is still Ask.
		await expect.element(segment(screen, "ask")).toHaveAttribute("aria-checked", "true");
		await expect.element(segment(screen, "deny")).toHaveAttribute("aria-checked", "false");
		expect(api.getPermissionRules).not.toHaveBeenCalled();
		expect(api.removeSavedApproval).not.toHaveBeenCalled();
		expect(api.respondPermission).not.toHaveBeenCalled();
		// Once the snapshot says Deny, it moves.
		await screen.rerender({ agent: session({ permissionMode: "deny" }) });
		await expect.element(segment(screen, "deny")).toHaveAttribute("aria-checked", "true");
	});

	it("falls back to onchanged when the parent gives no permission callback", async () => {
		const onchanged = vi.fn();
		const screen = mount(session(), { onchanged });
		await segment(screen, "allow").click();
		await vi.waitFor(() => expect(onchanged).toHaveBeenCalledTimes(1));
	});

	it("does not send when the clicked segment is already the machine's word", async () => {
		const screen = mount(session({ permissionMode: "ask" }));
		await segment(screen, "ask").click();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(api.setPermissionMode).not.toHaveBeenCalled();
	});

	it("shows the machine's refusal in the pill row, and does not move", async () => {
		api.setPermissionMode.mockRejectedValueOnce(new Error("a subagent follows its root"));
		const screen = mount(session());
		await segment(screen, "allow").click();
		await expect.element(screen.getByText("a subagent follows its root")).toBeVisible();
		await expect.element(segment(screen, "ask")).toHaveAttribute("aria-checked", "true");
	});

	it("names what the ceiling still caps under Allow", async () => {
		const allow = mount(session({ permissionMode: "allow" }), { ceiling: { bash: "ask" } });
		await expect
			.element(allow.getByTestId("permission-mode-note"))
			.toHaveTextContent(
				"Allow · bash asks (machine limit) · new subagents ask on their first turn"
			);
	});

	it("names several caps, and a denial as a denial", async () => {
		const allow = mount(session({ permissionMode: "allow" }), {
			ceiling: { bash: "ask", webfetch: "deny" },
		});
		await expect
			.element(allow.getByTestId("permission-mode-note"))
			.toHaveTextContent(
				"Allow · bash asks, webfetch is denied (machine limit) · new subagents ask on their first turn"
			);
	});

	it("under Allow with nothing capped, still says new subagents ask on their first turn, with the reason on hover", async () => {
		const screen = mount(session({ permissionMode: "allow" }), { ceiling: {} });
		const note = screen.getByTestId("permission-mode-note");
		await expect.element(note).toHaveTextContent(/^Allow · new subagents ask on their first turn$/);
		const title = note.element().getAttribute("title") ?? "";
		expect(title).toContain("before Cerea can hand it your permission setting");
		expect(title).not.toMatch(/turn two|second turn|from turn/i);
		// And the Allow segment's own tooltip carries it (the note hides on a phone).
		expect(segment(screen, "allow").element().getAttribute("title")).toContain(
			"a new subagent's first turn"
		);
	});

	it("does not name the ceiling or the first-turn caveat under Ask", async () => {
		const ask = mount(session({ permissionMode: "ask" }), { ceiling: { bash: "ask" } });
		await expect.element(segment(ask, "ask")).toBeVisible();
		expect(ask.getByTestId("permission-mode-note").elements()).toHaveLength(0);
	});

	it("tells Allow's two surviving asks on its tooltip, so nobody reads it as 'anything'", async () => {
		const screen = mount(session());
		const title = segment(screen, "allow").element().getAttribute("title") ?? "";
		expect(title).toContain("outside the project folder");
		expect(title).toContain("stuck");
		expect(segment(screen, "ask").element().getAttribute("title")).toContain("Reading is allowed");
	});

	it("is disabled on a subagent, showing its root's word and saying it follows the main session", async () => {
		const screen = mount(session({ parentId: "root-1", permissionMode: "deny" }));
		await expect.element(segment(screen, "deny")).toHaveAttribute("aria-checked", "true");
		for (const mode of ["deny", "ask", "allow"]) {
			await expect.element(segment(screen, mode)).toBeDisabled();
		}
		await expect
			.element(screen.getByTestId("permission-mode-note"))
			.toHaveTextContent("Follows the main session");
		expect(api.setPermissionMode).not.toHaveBeenCalled();
	});

	it("is absent when the machine gave no word (an older galopin)", async () => {
		const older = mount(session({ permissionMode: undefined }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(older.getByTestId("permission-mode").elements()).toHaveLength(0);
	});

	it("is absent when the snapshot read failed", async () => {
		const none = mount(null);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(none.getByTestId("permission-mode").elements()).toHaveLength(0);
	});

	it("is hidden while the /code sign-in is stale", async () => {
		const screen = mount(session());
		await expect.element(screen.getByTestId("permission-mode")).toBeVisible();
		flagCodeReauth();
		await vi.waitFor(() =>
			expect(screen.getByTestId("permission-mode").elements()).toHaveLength(0)
		);
	});

	it("has no Auto-accept pill any more, and no word of a responder", async () => {
		const screen = mount(session());
		await expect.element(screen.getByTestId("permission-mode")).toBeVisible();
		expect(screen.getByRole("button", { name: /auto-accept/i }).elements()).toHaveLength(0);
		const text = screen.container.textContent ?? "";
		expect(text).not.toMatch(/auto-accept|responder/i);
	});
});
