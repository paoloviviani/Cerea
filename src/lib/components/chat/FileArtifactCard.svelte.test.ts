import FileArtifactCard from "./FileArtifactCard.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { ARTIFACTS_CONTEXT_KEY, type ArtifactsContext } from "$lib/utils/artifactsContext";
import type { FileArtifactRegistry } from "$lib/utils/fileArtifacts";

/**
 * The session underneath the fallback FileCard is a controllable fake; the
 * card under test is real, so download wiring and fallback rendering are
 * exercised as shipped.
 */
const sessionMock = vi.hoisted(() => ({
	readFile: vi.fn(async () => new Uint8Array([104, 105]).buffer as ArrayBuffer),
	run: vi.fn(async () => ({ ok: true, stdout: "", stderr: "" })),
	listFiles: vi.fn(async () => []),
}));

vi.mock("$lib/utils/execution/runtime", () => ({
	getExecutionSession: () => sessionMock,
}));

const SHA_V1 = "1".repeat(64);
const SHA_V2 = "2".repeat(64);

/** Two versions of one file artifact, like a re-run that rewrote the file. */
const fileRegistry: FileArtifactRegistry = {
	artifacts: new Map([
		[
			"report.docx",
			{
				name: "report.docx",
				versions: [
					{ name: "report.docx", size: 10, sha256: SHA_V1, version: 1, messageId: "m1" },
					{ name: "report.docx", size: 12, sha256: SHA_V2, version: 2, messageId: "m1" },
				],
			},
		],
	]),
};

function context(fileRegistry: FileArtifactRegistry): Map<unknown, unknown> {
	const ctx: ArtifactsContext = {
		registry: { artifacts: new Map(), byMessageOp: new Map() },
		fileRegistry,
		panel: sidePane,
	};
	return new Map<unknown, unknown>([[ARTIFACTS_CONTEXT_KEY, ctx]]);
}

function mountCard(props: Record<string, unknown>, registry = fileRegistry) {
	return render(FileArtifactCard, {
		props,
		context: context(registry),
	} as never);
}

beforeEach(() => {
	sessionMock.readFile.mockClear();
	sessionMock.run.mockClear();
	// sidePane is a module singleton: an open panel left by one test would
	// leak into the next one's assertions.
	sidePane.reset();
});

describe("FileArtifactCard", () => {
	it("presents a registry-matched file as an artifact card with its kind", async () => {
		const screen = mountCard({
			file: { path: "report.docx", size: 12 },
			sha256: SHA_V2,
			downloadUrl: `/conversation/c/code-execution/output/${SHA_V2}`,
		});
		await expect.element(screen.getByText("report.docx")).toBeVisible();
		await expect.element(screen.getByText("Word · 12 B · v2")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Open report.docx in panel" }))
			.toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Download report.docx" }))
			.toBeVisible();
	});

	it("opens the panel at the exact version the sha resolves to", async () => {
		const open = vi.spyOn(sidePane, "openArtifact");
		// The latest of two versions follows the latest (version null).
		const screen = mountCard({ file: { path: "report.docx", size: 12 }, sha256: SHA_V2 });
		await screen.getByRole("button", { name: "Open report.docx in panel" }).click();
		expect(open).toHaveBeenCalledWith("report.docx", null);

		// An older version is pinned, so the panel shows exactly those bytes.
		screen.unmount();
		open.mockClear();
		const older = mountCard({ file: { path: "report.docx", size: 10 }, sha256: SHA_V1 });
		await older.getByRole("button", { name: "Open report.docx in panel" }).click();
		expect(open).toHaveBeenCalledWith("report.docx", 1);
	});

	it("omits the panel action when rendered inside the panel", async () => {
		const open = vi.spyOn(sidePane, "openArtifact");
		const screen = mountCard({
			file: { path: "report.docx", size: 12 },
			sha256: SHA_V2,
			inPanel: true,
		});
		expect(
			screen.baseElement.querySelector('button[aria-label="Open report.docx in panel"]')
		).toBeNull();
		await expect
			.element(screen.getByRole("button", { name: "Download report.docx" }))
			.toBeVisible();
		expect(open).not.toHaveBeenCalled();
	});

	it("falls back to the plain FileCard while the sha is unresolved", async () => {
		const screen = mountCard({
			file: { path: "report.docx", size: 12 },
			sha256: "f".repeat(64),
			downloadUrl: "/conversation/c/code-execution/output/unknown",
		});
		expect(
			screen.baseElement.querySelector('button[aria-label="Open report.docx in panel"]')
		).toBeNull();
		// The fallback is the FileCard itself, preview included.
		await expect.element(screen.getByRole("button", { name: "Preview report.docx" })).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Download report.docx" }))
			.toBeVisible();
	});

	it("falls back to the plain FileCard when no sha is known", async () => {
		const screen = mountCard({ file: { path: "/home/pyodide/notes.txt", size: 25 } });
		expect(
			screen.baseElement.querySelector('button[aria-label="Open notes.txt in panel"]')
		).toBeNull();
		await expect.element(screen.getByRole("button", { name: "Preview notes.txt" })).toBeVisible();
	});

	it("falls back to the plain FileCard without an artifacts context", async () => {
		const screen = render(FileArtifactCard, {
			props: { file: { path: "report.docx", size: 12 }, sha256: SHA_V2 },
		} as never);
		expect(
			screen.baseElement.querySelector('button[aria-label="Open report.docx in panel"]')
		).toBeNull();
		await expect
			.element(screen.getByRole("button", { name: "Download report.docx" }))
			.toBeVisible();
		expect(sessionMock.readFile).not.toHaveBeenCalled();
	});

	it("downloads through FileCard's machinery, from the persisted store", async () => {
		const blobs: Blob[] = [];
		const createObjectURL = vi
			.spyOn(URL, "createObjectURL")
			.mockImplementation((blob: Blob | MediaSource) => {
				blobs.push(blob as Blob);
				return "blob:mock";
			});
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const realFetch = globalThis.fetch;
		const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]).buffer));
		vi.stubGlobal("fetch", fetch);
		try {
			const screen = mountCard({
				file: { path: "report.docx", size: 3 },
				sha256: SHA_V2,
				downloadUrl: "/conversation/c/code-execution/output/x",
			});
			await screen.getByRole("button", { name: "Download report.docx" }).click();
			await vi.waitFor(() => expect(click).toHaveBeenCalled());
			const anchor = click.mock.contexts[0] as HTMLAnchorElement;
			expect(anchor.download).toBe("report.docx");
			expect(await blobs[0].text()).toBe("\u0001\u0002\u0003");
			expect(fetch).toHaveBeenCalledWith("/conversation/c/code-execution/output/x");
		} finally {
			createObjectURL.mockRestore();
			click.mockRestore();
			vi.stubGlobal("fetch", realFetch);
		}
	});
});
