import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentComposer from "./AgentComposer.svelte";
import { resetCodeReauth } from "$lib/stores/codeReauth.svelte";
import { PER_CLASS_DEFAULTS } from "$lib/types/AgentReview";
import type { CodeAgentSession } from "$lib/types/CodeAgent";
import type { CodeDeviceView } from "$lib/codeApi";
import type { Policy } from "$lib/types/machineProtocol";

/** ADR 0107 section 3: the third step's label and the computed line under the control. */
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
	...over,
});

const DEFAULT_LIMITS = {
	edit: "allow",
	web: "allow",
	tools: "allow",
	agents: "allow",
	command: "ask",
	outside: "ask",
	secrets: "ask",
	loop: "ask",
} as const;

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

const base: Policy = { workspaceRoots: [], allowFreeModels: false, limits: { ...DEFAULT_LIMITS } };

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

describe("the third step", () => {
	it("reads Auto when a reviewer is available and the device has not opted out", async () => {
		const screen = mount();
		await expect.element(screen.getByTestId("permission-mode-allow")).toBeVisible();
		expect(labels(screen)).toEqual(["Plan", "Ask", "Auto"]);
		await expect
			.element(screen.getByTestId("permission-mode-allow"))
			.toHaveAttribute("aria-checked", "true");
	});

	it("reads Allow with no reviewer (unconfigured, off or the kill switch), unknown state, or an opted-out device", async () => {
		for (const over of [
			{ autoApproval: { available: false, perClass: PER_CLASS_DEFAULTS } },
			{ autoApproval: null },
			{ device: device(base, { neverReview: true }) },
		]) {
			document.body.innerHTML = "";
			const screen = mount(over);
			await expect.element(screen.getByTestId("permission-mode-allow")).toBeVisible();
			expect(labels(screen)).toEqual(["Plan", "Ask", "Allow"]);
		}
	});

	it("still maps to the wire's allow", async () => {
		const screen = mount({ agent: session({ permissionMode: "ask" }) });
		await expect.element(screen.getByTestId("permission-mode-allow")).toHaveTextContent("Auto");
		await screen.getByTestId("permission-mode-allow").click();
		const { setPermissionMode } = await import("$lib/codeApi");
		await vi.waitFor(() => expect(setPermissionMode).toHaveBeenCalledWith("d1", "a1", "allow"));
	});
});

describe("below the composer", () => {
	it("renders no permission line and no details link, on any step", async () => {
		for (const permissionMode of ["allow", "ask", "deny"] as const) {
			document.body.innerHTML = "";
			const screen = mount({ agent: session({ permissionMode }) });
			await expect.element(screen.getByTestId("permission-mode-allow")).toBeVisible();
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
