import { describe, it, expect, vi, beforeEach } from "vitest";
import { page } from "@vitest/browser/context";
import { createRawSnippet } from "svelte";
import { render } from "vitest-browser-svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import TogglePill from "./TogglePill.svelte";
import AgentComposer from "./code/AgentComposer.svelte";
import { PILL_BASE, PILL_PRESSED, PILL_REST } from "./composerPill";
import type { CodeAgentSession } from "$lib/types/CodeAgent";

/**
 * Drift guard. The agent composer's pickers once kept a private copy of
 * chat's pill classes and slid away from it (height, accent, phone size).
 * Both now build from `composerPill.ts`; this pins that they still do, by
 * class and by measured height, at a phone and a desktop width.
 */
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listAgentCommands: async () => ({ commands: [] }),
	listProviderModes: async () => ({
		modes: [{ id: "build", label: "Build", description: "" }],
	}),
	getPermissionRules: async () => ({ rules: [], savedApprovals: [], ceiling: {} }),
}));

const icon = createRawSnippet(() => ({ render: () => `<svg></svg>` }));

const agent: CodeAgentSession = {
	id: "a1",
	workspaceId: "w1",
	title: "Build it",
	provider: "opencode",
	state: "idle",
	updatedAt: "2026-10-04T00:00:00Z",
	modeId: "build",
	modelId: null,
	permissionMode: "ask",
};

const tokens = (css: string) => css.split(/\s+/).filter(Boolean);

function mountAgent() {
	return renderWithApp(AgentComposer, {
		deviceId: "d1",
		agentId: "a1",
		agent,
		running: false,
		onsend: async () => {},
		onstop: async () => true,
		onchanged: () => {},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("composer pill parity: chat toggle vs agent picker", () => {
	for (const width of [360, 1200]) {
		it(`share the pill base, the neutral resting tone and one height at ${width}px`, async () => {
			await page.viewport(width, 800);
			const toggle = render(TogglePill, {
				pressed: false,
				compact: true,
				label: "Web search",
				onclick: () => {},
				icon,
			});
			const toggleEl = toggle.getByRole("button", { name: "Web search" }).element();
			const screen = mountAgent();
			const modeEl = screen.getByRole("button", { name: "Build" }).element();

			// Same shared classes, not a lookalike copy.
			for (const el of [toggleEl, modeEl]) {
				for (const t of [...tokens(PILL_BASE)]) expect(el.classList.contains(t), t).toBe(true);
				for (const t of tokens(PILL_REST)) expect(el.classList.contains(t), t).toBe(true);
				// A resting pill is neutral: never the pressed blue.
				for (const t of tokens(PILL_PRESSED)) expect(el.classList.contains(t), t).toBe(false);
			}

			// And they measure alike: chat's compact circle is size-8 on a
			// phone, 28px (h-7) from sm up; the picker shares the row height.
			const expected = width < 640 ? 32 : 28;
			expect(toggleEl.getBoundingClientRect().height).toBe(expected);
			expect(modeEl.getBoundingClientRect().height).toBe(expected);
			const group = screen.getByTestId("permission-mode").element();
			expect(group.getBoundingClientRect().height).toBe(expected);
		});
	}

	it("marks the selected permission segment with chat's pressed style, and no other", async () => {
		await page.viewport(1200, 800);
		const screen = mountAgent();
		const pressed = tokens(PILL_PRESSED);
		const ask = screen.getByTestId("permission-mode-ask").element();
		const deny = screen.getByTestId("permission-mode-deny").element();
		for (const t of pressed) expect(ask.classList.contains(t), t).toBe(true);
		expect(deny.classList.contains("bg-blue-100")).toBe(false);
	});
});
