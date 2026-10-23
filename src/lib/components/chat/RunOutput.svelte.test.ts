import RunOutput from "./RunOutput.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { ARTIFACTS_CONTEXT_KEY, type ArtifactsContext } from "$lib/utils/artifactsContext";
import type { RunState } from "$lib/utils/execution/runs.svelte";
import type { FileArtifactRegistry } from "$lib/utils/fileArtifacts";

/**
 * The session underneath is a controllable fake; the
 * output rendering under test is real.
 */
const sessionMock = vi.hoisted(() => ({
	readFile: vi.fn(async () => new Uint8Array([104, 105]).buffer as ArrayBuffer),
	run: vi.fn(async () => ({ ok: true, stdout: "", stderr: "" })),
	listFiles: vi.fn(async () => []),
}));

vi.mock("$lib/utils/execution/runtime", () => ({
	getExecutionSession: () => sessionMock,
}));

const SHA = "a".repeat(64);

const fileRegistry: FileArtifactRegistry = {
	artifacts: new Map([
		[
			"report.docx",
			{
				name: "report.docx",
				versions: [{ name: "report.docx", size: 12, sha256: SHA, version: 1, messageId: "m1" }],
			},
		],
	]),
};

const CONTEXT = new Map<unknown, unknown>([
	[
		ARTIFACTS_CONTEXT_KEY,
		{
			registry: { artifacts: new Map(), byMessageOp: new Map() },
			fileRegistry,
			panel: sidePane,
		} satisfies ArtifactsContext,
	],
]);

function mount(state: RunState) {
	return render(RunOutput, { props: { state }, context: CONTEXT } as never);
}

beforeEach(() => {
	sessionMock.readFile.mockClear();
	sessionMock.run.mockClear();
	sidePane.reset();
});

describe("RunOutput file presentation", () => {
	it("renders a persisted file whose sha is in the registry as an artifact card", async () => {
		const state: RunState = {
			status: "done",
			startedAt: 0,
			finishedAt: 1,
			persistedFiles: [
				{ name: "report.docx", size: 12, sha256: SHA, downloadUrl: "/conversation/c/x" },
			],
		};
		const screen = mount(state);
		await expect.element(screen.getByText("report.docx")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Open report.docx in panel" }))
			.toBeVisible();
	});

	it("renders a persisted file with an unknown sha as the same card, without Open", async () => {
		const state: RunState = {
			status: "done",
			startedAt: 0,
			finishedAt: 1,
			persistedFiles: [
				{ name: "other.txt", size: 5, sha256: "b".repeat(64), downloadUrl: "/conversation/c/y" },
			],
		};
		const screen = mount(state);
		await expect.element(screen.getByText("other.txt")).toBeVisible();
		expect(
			screen.baseElement.querySelector('button[aria-label="Open other.txt in panel"]')
		).toBeNull();
		expect(screen.baseElement.querySelector('[data-testid="file-artifact-card"]')).not.toBeNull();
		expect(screen.baseElement.querySelector('button[aria-label^="Preview"]')).toBeNull();
	});

	it("gives a live run's file the artifact card the moment its sha is in the registry, no upload needed", async () => {
		// The run's own listing carries the sha256 the browser computed: nothing
		// waits on an upload answer, which is what left the plain card live.
		const state: RunState = {
			status: "done",
			startedAt: 0,
			finishedAt: 1,
			outputFiles: [{ path: "/home/pyodide/report.docx", size: 12, sha256: SHA }],
		};
		const screen = mount(state);
		await expect
			.element(screen.getByRole("button", { name: "Open report.docx in panel" }))
			.toBeVisible();
	});

	it("draws files as divided rows inside the one surface, never cards in the card", async () => {
		const state: RunState = {
			status: "done",
			startedAt: 0,
			finishedAt: 1,
			outputFiles: [
				{ path: "/home/pyodide/report.docx", size: 12, sha256: SHA },
				{ path: "/home/pyodide/other.txt", size: 3, sha256: "b".repeat(64) },
			],
		};
		const screen = mount(state);
		const cards = screen.baseElement.querySelectorAll('[data-testid="file-artifact-card"]');
		expect(cards.length).toBe(2);
		// Rows, not tiles: no border box of their own, only a divider between rows.
		for (const card of cards) {
			expect(getComputedStyle(card).borderLeftWidth).toBe("0px");
			expect(getComputedStyle(card).borderRadius).toBe("0px");
			expect(getComputedStyle(card).backgroundColor).toBe("rgba(0, 0, 0, 0)");
		}
		expect(getComputedStyle(cards[0]).borderTopWidth).toBe("0px");
		const surface = screen.baseElement.querySelector('[data-testid="run-output"]') as HTMLElement;
		expect(surface.contains(cards[0])).toBe(true);
		expect(getComputedStyle(cards[1]).borderTopWidth).toBe("1px");
	});

	it("opens a live run's raster figure without waiting for a click", async () => {
		sessionMock.readFile.mockResolvedValueOnce(
			new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer as ArrayBuffer
		);
		const state: RunState = {
			status: "done",
			startedAt: 0,
			finishedAt: 1,
			outputFiles: [{ path: "/home/pyodide/figure-1.png", size: 8, sha256: "9".repeat(64) }],
		};
		const screen = mount(state);
		await expect
			.element(screen.getByRole("img", { name: "Preview of figure-1.png" }))
			.toBeVisible();
	});

	it("renders a persisted raster figure as an image under its artifact header", async () => {
		const FIG_SHA = "f".repeat(64);
		const figureRegistry: FileArtifactRegistry = {
			artifacts: new Map([
				[
					"figure-1.png",
					{
						name: "figure-1.png",
						versions: [
							{ name: "figure-1.png", size: 8, sha256: FIG_SHA, version: 1, messageId: "m1" },
						],
					},
				],
			]),
		};
		const figureContext = new Map<unknown, unknown>([
			[
				ARTIFACTS_CONTEXT_KEY,
				{
					registry: { artifacts: new Map(), byMessageOp: new Map() },
					fileRegistry: figureRegistry,
					panel: sidePane,
				} satisfies ArtifactsContext,
			],
		]);
		const realFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer))
		);
		try {
			const state: RunState = {
				status: "done",
				startedAt: 0,
				finishedAt: 1,
				persistedFiles: [
					{ name: "figure-1.png", size: 8, sha256: FIG_SHA, downloadUrl: "/conversation/c/x" },
				],
			};
			const screen = render(RunOutput, { props: { state }, context: figureContext } as never);
			await expect.element(screen.getByText("figure-1.png")).toBeVisible();
			await expect
				.element(screen.getByRole("img", { name: "Preview of figure-1.png" }))
				.toBeVisible();
		} finally {
			vi.stubGlobal("fetch", realFetch);
		}
	});
});
