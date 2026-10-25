import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { unbracketedText } from "$lib/components/__tests__/pseudoText";
import { m } from "$lib/paraglide/messages";
import { overwriteGetLocale } from "$lib/paraglide/runtime.js";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { clearTranscripts } from "$lib/stores/agentTranscriptCache";
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";
import AgentView from "./AgentView.svelte";

/** The machine is a fake: an empty history, and a snapshot the header can draw. */
const fake = vi.hoisted(() => ({ release: null as null | (() => void) }));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeAgentStream", () => ({
	agentStreamUrl: () => "",
	async *codeAgentStream(_device: string, _agent: string, signal: AbortSignal) {
		await new Promise<void>((resolve) => {
			fake.release = resolve;
			signal.addEventListener("abort", () => resolve());
		});
		yield { type: "historyDone" } as AgentStreamUpdate;
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
			permissionMode: "ask",
			parentId: null,
		},
		cwd: "/w",
		enrollmentExpired: false,
	}),
	listWorkspaces: async () => ({ workspaces: [] }),
	listSubagents: async () => ({ subagents: [] }),
	listProviderModes: async () => ({ modes: [] }),
	listProviderModels: async () => ({ models: [] }),
	getPermissionRules: async () => ({
		mode: "ask",
		rules: [],
		savedApprovals: [],
		ceiling: {},
		coordination: [],
	}),
}));

beforeEach(() => {
	fake.release = null;
	clearTranscripts();
	sidePane.reset();
	overwriteGetLocale(() => "en-XA");
});
afterEach(() => overwriteGetLocale(() => "en"));

describe("The agent screen, in the pseudo-locale", () => {
	it("owns every word it shows", async () => {
		await browserPage.viewport(1200, 800);
		codeDeviceList.devices = [
			{ id: "d1", name: "Box", status: "paired", online: true },
		] as typeof codeDeviceList.devices;
		codeDeviceList.loading = false;
		const screen = renderWithApp(AgentView, { deviceId: "d1", agentId: "a1", workspaceId: "w1" });
		await vi.waitFor(() => expect(fake.release).not.toBeNull());
		fake.release?.();
		await expect
			.element(screen.getByText(m["code.view.ready"]({}, { locale: "en-XA" })))
			.toBeVisible();
		await expect.element(screen.getByRole("radiogroup")).toBeVisible();
		// The session's own name and the backend are data.
		expect(
			unbracketedText(document.body, [
				/Build it/,
				/^opencode$/,
				// Shared chat components, converted with the chat area.
				"Conversation messages",
				/dictation|speech recognition/,
			])
		).toEqual([]);
	});
});
