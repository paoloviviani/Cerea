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
		autoApproval?: { available: boolean; perClass: typeof PER_CLASS_DEFAULTS } | null;
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

describe("the computed line", () => {
	it("for a default machine names what runs, what is reviewed and what comes to the user", async () => {
		const screen = mount();
		await expect
			.element(screen.getByTestId("auto-line"))
			.toHaveTextContent(
				"Auto on studio-laptop: edits, web, agents and tools run · commands and outside access are reviewed · secrets and loops come to you"
			);
	});

	it("for a machine with commands=run, commands run", async () => {
		const screen = mount({
			device: device({ ...base, limits: { ...DEFAULT_LIMITS, command: "allow" } }),
		});
		await expect
			.element(screen.getByTestId("auto-line"))
			.toHaveTextContent(
				"edits, commands, web, agents and tools run · outside access are reviewed"
			);
	});

	it("for an older machine derives the default ceiling and says so in the details", async () => {
		const old: Policy = { workspaceRoots: [], allowFreeModels: false, permission: { max: {} } };
		const screen = mount({ device: device(old) });
		await expect
			.element(screen.getByTestId("auto-line"))
			.toHaveTextContent("commands and outside access are reviewed");
		await screen.getByTestId("auto-details-toggle").click();
		await expect.element(screen.getByTestId("auto-older")).toHaveTextContent("older galopin");
	});

	it("says Allow and that asks come to the user when there is no reviewer", async () => {
		const screen = mount({ autoApproval: { available: false, perClass: PER_CLASS_DEFAULTS } });
		await expect
			.element(screen.getByTestId("auto-line"))
			.toHaveTextContent("Allow on studio-laptop:");
		await expect
			.element(screen.getByTestId("auto-line"))
			.toHaveTextContent("commands, outside access, secrets and loops come to you");
	});

	it("gives each class's outcome and reason in the details", async () => {
		const screen = mount();
		await screen.getByTestId("auto-details-toggle").click();
		const details = screen.getByTestId("auto-details");
		await expect.element(details).toBeVisible();
		await expect.element(screen.getByTestId("auto-row-command")).toHaveTextContent("Reviewed");
		await expect.element(screen.getByTestId("auto-row-edit")).toHaveTextContent("Runs");
		await expect.element(details).toHaveTextContent("This machine's limit");
		await expect.element(details).toHaveTextContent("Set by your admin");
	});

	it("is absent on Plan and Ask", async () => {
		const screen = mount({ agent: session({ permissionMode: "ask" }) });
		await expect.element(screen.getByTestId("permission-mode-allow")).toBeVisible();
		expect(document.querySelector('[data-testid="auto-line"]')).toBeNull();
	});
});
