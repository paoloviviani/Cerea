import RunOutput from "./RunOutput.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { ARTIFACTS_CONTEXT_KEY, type ArtifactsContext } from "$lib/utils/artifactsContext";
import type { RunState } from "$lib/utils/execution/runs.svelte";
import type { FileArtifactRegistry } from "$lib/utils/fileArtifacts";

/**
 * The session underneath the fallback FileCard is a controllable fake; the
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

	it("renders a persisted file with an unknown sha as the plain FileCard", async () => {
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
		// The fallback is the FileCard itself, preview included.
		await expect.element(screen.getByRole("button", { name: "Preview other.txt" })).toBeVisible();
	});

	it("renders a live run's output files as the plain FileCard — no sha to join on", async () => {
		const state: RunState = {
			status: "done",
			startedAt: 0,
			finishedAt: 1,
			outputFiles: [{ path: "/home/pyodide/notes.txt", size: 25 }],
		};
		const screen = mount(state);
		await expect.element(screen.getByText("notes.txt")).toBeVisible();
		expect(
			screen.baseElement.querySelector('button[aria-label="Open notes.txt in panel"]')
		).toBeNull();
		await expect.element(screen.getByRole("button", { name: "Download notes.txt" })).toBeVisible();
	});

	it("opens a live run's raster figure without waiting for a click", async () => {
		sessionMock.readFile.mockResolvedValueOnce(
			new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer as ArrayBuffer
		);
		const state: RunState = {
			status: "done",
			startedAt: 0,
			finishedAt: 1,
			outputFiles: [{ path: "/home/pyodide/figure-1.png", size: 8 }],
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
