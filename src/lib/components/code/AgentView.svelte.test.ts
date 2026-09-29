import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentView from "./AgentView.svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";
import type { PlanStep } from "$lib/types/Plan";

/**
 * The machine is a fake: the stream is a gate the test opens with the frames
 * it wants, and the api answers only what the header needs. What is under test
 * is the view's own decision about when the Tasks pane opens by itself.
 */
const fake = vi.hoisted(() => ({
	frames: [] as unknown[],
	release: null as null | (() => void),
}));

// The composer's MCP stores read `$env/dynamic/public` at module scope and
// fetch on import; no SvelteKit env or API exists in the browser project.
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeAgentStream", () => ({
	agentStreamUrl: () => "",
	async *codeAgentStream(_device: string, _agent: string, signal: AbortSignal) {
		// Held until the test says the frames have "arrived".
		await new Promise<void>((resolve) => {
			fake.release = resolve;
			signal.addEventListener("abort", () => resolve());
		});
		for (const frame of fake.frames) yield frame as AgentStreamUpdate;
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
	},
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	getAgent: async () => ({
		agent: {
			id: "a1",
			workspaceId: "w1",
			title: "Build it",
			provider: "opencode",
			state: "idle",
			updatedAt: "2026-09-30T00:00:00Z",
			modeId: null,
			modelId: null,
		},
		features: [],
		cwd: "/w",
		enrollmentExpired: false,
	}),
	listWorkspaces: async () => ({ workspaces: [] }),
	listSubagents: async () => ({ subagents: [] }),
	listProviderModes: async () => ({ modes: [] }),
	listProviderModels: async () => ({ models: [] }),
	listProviderFeatures: async () => ({ features: [] }),
}));

const plan = (steps: PlanStep[]) => ({
	type: MessageUpdateType.Plan,
	uuid: "agent-plan-a1",
	goal: steps[0]?.step ?? "",
	version: 1,
	steps,
});
const ACTIVE = plan([
	{ step: "write the view", status: "in_progress" },
	{ step: "ship", status: "pending" },
]);

function mount() {
	codeDeviceList.devices = [
		{ id: "d1", name: "Box", status: "paired", online: true },
	] as typeof codeDeviceList.devices;
	codeDeviceList.loading = false;
	return renderWithApp(AgentView, { deviceId: "d1", agentId: "a1", workspaceId: "w1" });
}

async function arrive(frames: unknown[]) {
	await vi.waitFor(() => expect(fake.release).not.toBeNull());
	fake.frames = frames;
	fake.release?.();
}

beforeEach(() => {
	fake.frames = [];
	fake.release = null;
	sidePane.reset();
});

describe("AgentView Tasks pane", () => {
	it("opens itself once for an active list on a wide screen, and stays closed after a close", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		expect(sidePane.open).toBe(false);
		await arrive([ACTIVE]);
		await expect.element(screen.getByTestId("code-tasks")).toBeVisible();
		expect(sidePane.view).toBe("tasks");

		// The person closes it: the same list does not bring it back, even as
		// it moves along (same session, same first item).
		sidePane.close();
		fake.frames = [];
		await expect.element(screen.getByRole("button", { name: "Tasks 0/2" })).toBeVisible();
		expect(sidePane.open).toBe(false);
	});

	it("never replaces a view that is already open, and does not come back when it closes", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		sidePane.openDiff();
		await arrive([ACTIVE]);
		await expect.element(screen.getByRole("button", { name: "Tasks 0/2" })).toBeVisible();
		expect(sidePane.view).toBe("diff");
		expect(sidePane.open).toBe(true);

		sidePane.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(sidePane.open).toBe(false);
	});

	it("never opens on a narrow viewport", async () => {
		await browserPage.viewport(400, 800);
		const screen = mount();
		await arrive([ACTIVE]);
		await expect.element(screen.getByRole("button", { name: "Tasks 0/2" })).toBeVisible();
		// The label is folded away here; the count stays visible.
		await expect.element(screen.getByTestId("pill-badge")).toHaveTextContent("0/2");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(sidePane.open).toBe(false);
	});

	it("does not open for a list that is finished, and the pill still counts it", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await arrive([plan([{ step: "done already", status: "completed" }])]);
		await expect.element(screen.getByRole("button", { name: "Tasks 1/1" })).toBeVisible();
		expect(sidePane.open).toBe(false);
	});
});
