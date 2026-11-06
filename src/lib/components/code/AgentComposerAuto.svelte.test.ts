import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentComposer from "./AgentComposer.svelte";
import { resetCodeReauth } from "$lib/stores/codeReauth.svelte";
import { PER_CLASS_DEFAULTS } from "$lib/types/AgentReview";
import type { CodeAgentSession } from "$lib/types/CodeAgent";
import type { CodeDeviceView } from "$lib/codeApi";
import type { Policy } from "$lib/types/machineProtocol";

/** ADR 0109 amendment: the four steps, Plan · Ask · Auto · Allow; Auto is `allow` with its map. */
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listAgentCommands: async () => ({ commands: [] }),
	setPermissionMode: vi.fn(async () => ({ ok: true })),
}));

const session = (over: Partial<CodeAgentSession> = {}): CodeAgentSession => ({
	id: "a1",
	workspaceId: "w1",
	title: "Build it",
	provider: "opencode",
	state: "idle",
	updatedAt: "2026-10-03T00:00:00Z",
	modeId: null,
	modelId: null,
	permissionMode: "allow",
	autoClasses: { command: "ask", edit: "run" },
	...over,
});

const device = (policy: Policy, extra: Partial<CodeDeviceView> = {}): CodeDeviceView =>
	({
		id: "d1",
		name: "studio-laptop",
		status: "paired",
		backends: [],
		policy,
		credentialState: "ok",
		online: true,
		createdAt: new Date(),
		...extra,
	}) as unknown as CodeDeviceView;

const base: Policy = { workspaceRoots: [], allowFreeModels: false };

function mount(
	over: {
		device?: CodeDeviceView;
		autoApproval?: {
			available: boolean;
			perClass: typeof PER_CLASS_DEFAULTS;
			degraded?: boolean;
		} | null;
		agent?: CodeAgentSession;
	} = {}
) {
	return renderWithApp(AgentComposer, {
		deviceId: "d1",
		agentId: "a1",
		agent: over.agent ?? session(),
		running: false,
		onsend: async () => {},
		onstop: async () => true,
		onchanged: () => {},
		device: over.device ?? device(base),
		policy: (over.device ?? device(base)).policy,
		autoApproval:
			over.autoApproval === undefined
				? { available: true, perClass: PER_CLASS_DEFAULTS }
				: over.autoApproval,
	});
}

const labels = (screen: ReturnType<typeof mount>) =>
	screen
		.getByRole("radiogroup", { name: "Permission for this session" })
		.getByRole("radio")
		.elements()
		.map((el) => el.textContent?.trim());

beforeEach(async () => {
	vi.clearAllMocks();
	resetCodeReauth();
	await browserPage.viewport(1200, 800);
});

describe("the four steps", () => {
	it("always offers Plan, Ask, Auto and Allow, with or without a reviewer", async () => {
		for (const over of [
			{},
			{ autoApproval: { available: false, perClass: PER_CLASS_DEFAULTS } },
			{ autoApproval: null },
			{ device: device(base, { neverReview: true }) },
		]) {
			document.body.innerHTML = "";
			const screen = mount(over);
			await expect.element(screen.getByTestId("permission-mode-auto")).toBeVisible();
			expect(labels(screen)).toEqual(["Plan", "Ask", "Auto", "Allow"]);
		}
	});

	it("reads `allow` with its map as Auto, and without one as Allow", async () => {
		const auto = mount();
		await expect
			.element(auto.getByTestId("permission-mode-auto"))
			.toHaveAttribute("aria-checked", "true");
		await expect
			.element(auto.getByTestId("permission-mode-allow"))
			.toHaveAttribute("aria-checked", "false");
		document.body.innerHTML = "";
		const allow = mount({ agent: session({ autoClasses: undefined }) });
		await expect
			.element(allow.getByTestId("permission-mode-allow"))
			.toHaveAttribute("aria-checked", "true");
		await expect
			.element(allow.getByTestId("permission-mode-auto"))
			.toHaveAttribute("aria-checked", "false");
	});

	it("Auto sends the word allow with auto, Allow sends allow alone", async () => {
		const { setPermissionMode } = await import("$lib/codeApi");
		const screen = mount({ agent: session({ permissionMode: "ask", autoClasses: undefined }) });
		await screen.getByTestId("permission-mode-auto").click();
		await vi.waitFor(() =>
			expect(setPermissionMode).toHaveBeenCalledWith("d1", "a1", "allow", { auto: true })
		);
		await screen.getByTestId("permission-mode-allow").click();
		await vi.waitFor(() =>
			expect(setPermissionMode).toHaveBeenLastCalledWith("d1", "a1", "allow", { auto: false })
		);
	});

	it("moving from Auto to Allow is a change even though the wire word is the same", async () => {
		const { setPermissionMode } = await import("$lib/codeApi");
		const screen = mount();
		await screen.getByTestId("permission-mode-allow").click();
		await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledTimes(1));
	});
});

describe("below the composer", () => {
	it("renders no permission line and no details link, on any step", async () => {
		for (const permissionMode of ["allow", "ask", "deny"] as const) {
			document.body.innerHTML = "";
			const screen = mount({ agent: session({ permissionMode }) });
			await expect.element(screen.getByTestId("permission-mode-auto")).toBeVisible();
			expect(document.querySelector('[data-testid="auto-line-wrap"]')).toBeNull();
			expect(document.querySelector('[data-testid="auto-line"]')).toBeNull();
			expect(document.querySelector('[data-testid="auto-details-toggle"]')).toBeNull();
			expect(document.body.textContent).not.toMatch(/come to you|Details/);
		}
	});

	it("names the selected step on the shield for assistive tech", async () => {
		const screen = mount();
		await expect
			.element(screen.getByTestId("permission-details"))
			.toHaveAttribute("aria-label", "Permissions: Auto");
		document.body.innerHTML = "";
		const ask = mount({ agent: session({ permissionMode: "ask" }) });
		await expect
			.element(ask.getByTestId("permission-details"))
			.toHaveAttribute("aria-label", "Permissions: Ask");
	});
});
