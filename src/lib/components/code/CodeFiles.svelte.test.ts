import CodeFiles from "./CodeFiles.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FileEntry, FilesReadResult } from "$lib/types/machineProtocol";

/**
 * The machine behind the explorer is a controllable fake; the branch
 * decisions under test (raster img, SVG text fallback, too_large message)
 * are the real component's.
 */
const apiMock = vi.hoisted(() => ({
	listWorkspaceFiles: vi.fn(),
	readWorkspaceFile: vi.fn(),
	workspaceFileStatus: vi.fn(),
}));

vi.mock("$lib/codeApi", () => ({
	CodeApiError: class CodeApiError extends Error {
		status: number;
		constructor(message: string, status: number) {
			super(message);
			this.name = "CodeApiError";
			this.status = status;
		}
	},
	listWorkspaceFiles: apiMock.listWorkspaceFiles,
	readWorkspaceFile: apiMock.readWorkspaceFile,
	workspaceFileStatus: apiMock.workspaceFileStatus,
	workspaceFileRawUrl: (_deviceId: string, _workspaceId: string, path: string) =>
		`/api/v2/code/v1/workspaces/ws/files/raw?device=d&path=${encodeURIComponent(path)}`,
}));

function fileEntry(name: string): FileEntry {
	return {
		name,
		path: name,
		type: "file",
		size: 8,
		mtime: "2026-09-28T00:00:00Z",
		hidden: false,
		ignored: false,
		redacted: false,
	};
}

function imageResult(mime: string): FilesReadResult {
	return {
		path: "plot.png",
		revision: "r1",
		size: 8,
		offset: 0,
		length: 8,
		eof: true,
		kind: "image",
		mime,
		encoding: "none",
	};
}

function mount(names: string[]) {
	apiMock.listWorkspaceFiles.mockResolvedValue({
		path: ".",
		entries: names.map(fileEntry),
		truncated: false,
	});
	apiMock.workspaceFileStatus.mockResolvedValue({ isGitRepo: false, entries: [] });
	return render(CodeFiles, { deviceId: "d", workspaceId: "ws" });
}

async function open(screen: ReturnType<typeof render>, name: string) {
	await expect.element(screen.getByRole("button", { name })).toBeVisible();
	await screen.getByRole("button", { name }).click();
}

beforeEach(() => {
	apiMock.listWorkspaceFiles.mockReset();
	apiMock.readWorkspaceFile.mockReset();
	apiMock.workspaceFileStatus.mockReset();
});

describe("CodeFiles image view", () => {
	it("renders a raster image from the raw route, not the text viewer", async () => {
		apiMock.readWorkspaceFile.mockResolvedValue(imageResult("image/png"));
		const screen = mount(["plot.png"]);
		await open(screen, "plot.png");
		const img = screen.getByRole("img", { name: "plot.png" });
		await expect.element(img).toBeVisible();
		expect(img.element().getAttribute("src")).toContain("/files/raw");
		// The CodeMirror viewer owns text files only.
		expect(screen.baseElement.querySelector('[data-testid="file-viewer"]')).toBeNull();
	});

	it("a mislabelled SVG never takes the image branch — it keeps the text view", async () => {
		// galopin labels SVG as text and the raw route 415s non-raster, so
		// this kind can only arrive from a misbehaving machine; the
		// component still refuses the <img> (script-capable document).
		apiMock.readWorkspaceFile.mockResolvedValue({
			...imageResult("image/svg+xml"),
			content: "<svg></svg>",
			encoding: "utf-8",
		});
		const screen = mount(["fig.svg"]);
		await open(screen, "fig.svg");
		await expect.element(screen.getByTestId("file-viewer")).toBeVisible();
		expect(screen.baseElement.querySelector("img")).toBeNull();
	});

	it("answers too_large with the limit message, not the wire error", async () => {
		const { CodeApiError } = await import("$lib/codeApi");
		apiMock.readWorkspaceFile.mockRejectedValue(
			new CodeApiError("images are shown up to 8388608 bytes", 413)
		);
		const screen = mount(["huge.png"]);
		await open(screen, "huge.png");
		// The machine's byte count never reaches the person; the limit does.
		await expect
			.element(screen.getByText("This file is too large to show here.", { exact: false }))
			.toBeVisible();
		expect(screen.baseElement.querySelector("img")).toBeNull();
	});

	it("keeps showing ordinary failures verbatim", async () => {
		apiMock.readWorkspaceFile.mockRejectedValue(new Error("the machine went away"));
		const screen = mount(["notes.txt"]);
		await open(screen, "notes.txt");
		await expect.element(screen.getByText("the machine went away")).toBeVisible();
	});
});
