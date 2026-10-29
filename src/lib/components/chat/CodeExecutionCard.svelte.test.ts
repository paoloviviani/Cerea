import CodeExecutionCard from "./CodeExecutionCard.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { ARTIFACTS_CONTEXT_KEY, type ArtifactsContext } from "$lib/utils/artifactsContext";
import type { FileArtifactRegistry } from "$lib/utils/fileArtifacts";
import { MessageUpdateType, MessageCodeExecutionUpdateType } from "$lib/types/MessageUpdate";

/**
 * The session underneath is a controllable fake. The
 * card under test renders replay-only (`resolved` set), so no run is kicked
 * and nothing is posted back.
 */
const sessionMock = vi.hoisted(() => ({
	readFile: vi.fn(async () => new Uint8Array([104, 105]).buffer as ArrayBuffer),
	run: vi.fn(async () => ({ ok: true, stdout: "", stderr: "" })),
	listFiles: vi.fn(async () => []),
	onStatus: vi.fn(),
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

function context(registry: FileArtifactRegistry): Map<unknown, unknown> {
	return new Map<unknown, unknown>([
		[
			ARTIFACTS_CONTEXT_KEY,
			{
				registry: { artifacts: new Map(), byMessageOp: new Map() },
				fileRegistry: registry,
				panel: sidePane,
			} satisfies ArtifactsContext,
		],
	]);
}

const request = {
	type: MessageUpdateType.CodeExecution,
	subtype: MessageCodeExecutionUpdateType.Request,
	executionId: "exec-1",
	code: "make_report()",
};

function resolvedWith(sha: string) {
	return {
		type: MessageUpdateType.CodeExecution,
		subtype: MessageCodeExecutionUpdateType.Resolved,
		executionId: "exec-1",
		outcome: { ok: true, stdout: "", stderr: "" },
		files: [{ name: "report.docx", size: 12, sha256: sha }],
	};
}

function mount(sha: string, registry = fileRegistry) {
	return render(CodeExecutionCard, {
		props: {
			conversationId: "conv-1",
			request,
			resolved: resolvedWith(sha),
		},
		context: context(registry),
	} as never);
}

beforeEach(() => {
	sessionMock.readFile.mockClear();
	sessionMock.run.mockClear();
	sidePane.reset();
});

describe("CodeExecutionCard file presentation (replay)", () => {
	it("renders a persisted file whose sha is in the registry as an artifact card", async () => {
		const screen = mount(SHA);
		await expect.element(screen.getByText("report.docx")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Open report.docx in panel" }))
			.toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Download report.docx" }))
			.toBeVisible();
	});

	it("renders a persisted file with an unknown sha as the same card, without Open", async () => {
		const screen = mount("b".repeat(64));
		await expect.element(screen.getByText("report.docx")).toBeVisible();
		expect(
			screen.baseElement.querySelector('button[aria-label="Open report.docx in panel"]')
		).toBeNull();
		expect(screen.baseElement.querySelector('button[aria-label^="Preview"]')).toBeNull();
		await expect
			.element(screen.getByRole("button", { name: "Download report.docx" }))
			.toBeVisible();
	});

	it("shows one header row, 'Ran Python', and no separate tool line", async () => {
		const screen = mount(SHA);
		await expect.element(screen.getByText("Ran Python")).toBeVisible();
		expect(screen.baseElement.textContent).not.toContain("Called tool");
		expect(screen.baseElement.textContent).not.toContain("Assistant-run code");
		// The file is visible with the code folded.
		expect(screen.baseElement.querySelector('[data-testid="run-code"]')).toBeNull();
	});

	it("says a failed run failed without showing the traceback until opened", async () => {
		const screen = render(CodeExecutionCard, {
			props: {
				conversationId: "conv-1",
				request,
				resolved: {
					...resolvedWith(SHA),
					files: undefined,
					outcome: { ok: false, stdout: "", stderr: "", error: "NameError: make_report" },
				},
			},
			context: context(fileRegistry),
		} as never);
		await expect.element(screen.getByText("Failed")).toBeVisible();
		expect(screen.baseElement.textContent).not.toContain("NameError: make_report");
		await screen.getByRole("button", { expanded: false }).click();
		await expect.element(screen.getByText("NameError: make_report")).toBeVisible();
	});

	it("says a file was not saved after a reload when its record is uploaded: false", async () => {
		const NS = "c".repeat(64);
		const registry: FileArtifactRegistry = {
			artifacts: new Map([
				[
					"report.docx",
					{
						name: "report.docx",
						versions: [
							{
								name: "report.docx",
								size: 12,
								sha256: NS,
								version: 1,
								messageId: "m1",
								uploaded: false,
							},
						],
					},
				],
			]),
		};
		const screen = render(CodeExecutionCard, {
			props: {
				conversationId: "conv-1",
				request,
				resolved: {
					...resolvedWith(NS),
					files: [{ name: "report.docx", size: 12, sha256: NS, uploaded: false }],
				},
			},
			context: context(registry),
		} as never);
		await expect.element(screen.getByTestId("file-not-saved")).toBeVisible();
	});

	it("opens a replayed raster figure as an image under its artifact header", async () => {
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
		const realFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer))
		);
		try {
			const screen = render(CodeExecutionCard, {
				props: {
					conversationId: "conv-1",
					request,
					resolved: {
						...resolvedWith(FIG_SHA),
						files: [{ name: "figure-1.png", size: 8, sha256: FIG_SHA }],
					},
				},
				context: context(figureRegistry),
			} as never);
			await expect.element(screen.getByText("figure-1.png")).toBeVisible();
			await expect
				.element(screen.getByRole("img", { name: "Preview of figure-1.png" }))
				.toBeVisible();
		} finally {
			vi.stubGlobal("fetch", realFetch);
		}
	});
});

describe("CodeExecutionCard file presentation (live run)", () => {
	it("gives the run's own file the artifact card without waiting for any upload", async () => {
		// The tab that ran the code still holds the run. The browser fingerprints
		// the file when the sandbox lists it, so the card joins the registry by
		// that sha256 right away; the upload here never answers at all.
		const HI = "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4";
		const registry: FileArtifactRegistry = {
			artifacts: new Map([
				[
					"report.docx",
					{
						name: "report.docx",
						versions: [{ name: "report.docx", size: 2, sha256: HI, version: 1, messageId: "m1" }],
					},
				],
			]),
		};
		sessionMock.listFiles.mockResolvedValueOnce([
			{ path: "/home/pyodide/report.docx", size: 2 },
		] as never);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise(() => {}))
		);
		try {
			const screen = render(CodeExecutionCard, {
				props: { conversationId: "conv-live", request: { ...request, code: "make_live_report()" } },
				context: context(registry),
			} as never);
			await expect
				.element(screen.getByRole("button", { name: "Open report.docx in panel" }))
				.toBeVisible();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("shows the same card live and after a reload, from what the turn stored", async () => {
		const HI = "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4";
		const registry: FileArtifactRegistry = {
			artifacts: new Map([
				[
					"report.docx",
					{
						name: "report.docx",
						versions: [{ name: "report.docx", size: 2, sha256: HI, version: 1, messageId: "m1" }],
					},
				],
			]),
		};
		sessionMock.listFiles.mockResolvedValueOnce([
			{ path: "/home/pyodide/report.docx", size: 2 },
		] as never);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise(() => {}))
		);
		try {
			const live = render(CodeExecutionCard, {
				props: {
					conversationId: "conv-parity",
					request: { ...request, code: "make_parity_report()" },
				},
				context: context(registry),
			} as never);
			await expect
				.element(live.getByRole("button", { name: "Open report.docx in panel" }))
				.toBeVisible();
			const shape = (root: HTMLElement) =>
				Array.from(root.querySelectorAll('[data-testid="file-artifact-card"]')).map((card) => ({
					text: (card.textContent ?? "").replace(/\s+/g, " ").trim(),
					classes: card.className,
					buttons: Array.from(card.querySelectorAll("button")).map((b) =>
						b.getAttribute("aria-label")
					),
				}));
			const liveShape = shape(live.baseElement);
			live.unmount();

			// A reload: no run in this tab, only what the turn stored.
			const replay = render(CodeExecutionCard, {
				props: {
					conversationId: "conv-parity",
					request: { ...request, code: "another_code_so_no_live_run()" },
					resolved: {
						...resolvedWith(HI),
						files: [{ name: "report.docx", size: 2, sha256: HI }],
					},
				},
				context: context(registry),
			} as never);
			await expect
				.element(replay.getByRole("button", { name: "Open report.docx in panel" }))
				.toBeVisible();
			expect(liveShape.length).toBe(1);
			expect(shape(replay.baseElement)).toEqual(liveShape);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
