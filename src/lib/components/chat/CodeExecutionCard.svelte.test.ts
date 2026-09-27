import CodeExecutionCard from "./CodeExecutionCard.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { ARTIFACTS_CONTEXT_KEY, type ArtifactsContext } from "$lib/utils/artifactsContext";
import type { FileArtifactRegistry } from "$lib/utils/fileArtifacts";
import { MessageUpdateType, MessageCodeExecutionUpdateType } from "$lib/types/MessageUpdate";

/**
 * The session underneath the fallback FileCard is a controllable fake. The
 * card under test renders replay-only (`resolved` set), so no run is kicked
 * and nothing is posted back.
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

	it("renders a persisted file with an unknown sha as the plain FileCard", async () => {
		const screen = mount("b".repeat(64));
		await expect.element(screen.getByText("report.docx")).toBeVisible();
		expect(
			screen.baseElement.querySelector('button[aria-label="Open report.docx in panel"]')
		).toBeNull();
		// The fallback is the FileCard itself, preview included.
		await expect.element(screen.getByRole("button", { name: "Preview report.docx" })).toBeVisible();
	});
});
