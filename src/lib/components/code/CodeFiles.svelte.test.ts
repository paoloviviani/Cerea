import CodeFiles from "./CodeFiles.svelte";
import { render } from "vitest-browser-svelte";
import { userEvent } from "@vitest/browser/context";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { navigation } from "$lib/components/__tests__/appMocks";
import { sidePane } from "$lib/stores/sidePane.svelte";
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
	writeWorkspaceFile: vi.fn(),
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
	FileConflictError: class FileConflictError extends Error {
		status = 409;
		revision: string | null;
		constructor(message: string, revision: string | null) {
			super(message);
			this.name = "FileConflictError";
			this.revision = revision;
		}
	},
	writeWorkspaceFile: apiMock.writeWorkspaceFile,
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

function mount(names: string[], writable = false) {
	apiMock.listWorkspaceFiles.mockResolvedValue({
		path: ".",
		entries: names.map(fileEntry),
		truncated: false,
	});
	apiMock.workspaceFileStatus.mockResolvedValue({ isGitRepo: false, entries: [] });
	return render(CodeFiles, { deviceId: "d", workspaceId: "ws", writable });
}

function textResult(path: string, content: string, over: Partial<FilesReadResult> = {}) {
	return {
		path,
		revision: "r1",
		size: content.length,
		offset: 0,
		length: content.length,
		eof: true,
		kind: "text",
		mime: "text/plain",
		encoding: "utf-8",
		content,
		...over,
	} satisfies FilesReadResult;
}

async function open(screen: ReturnType<typeof render>, name: string) {
	await expect.element(screen.getByRole("button", { name })).toBeVisible();
	await screen.getByRole("button", { name }).click();
}

beforeEach(() => {
	apiMock.listWorkspaceFiles.mockReset();
	apiMock.readWorkspaceFile.mockReset();
	apiMock.workspaceFileStatus.mockReset();
	apiMock.writeWorkspaceFile.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
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

describe("CodeFiles editor (files.write)", () => {
	/** Open notes.txt in the editor and type at the end of its text. */
	async function editNotes(screen: ReturnType<typeof render>, typed: string) {
		await open(screen, "notes.txt");
		await screen.getByTestId("file-edit").click();
		await expect
			.poll(() => screen.baseElement.querySelector(".cm-content")?.getAttribute("contenteditable"))
			.toBe("true");
		await expect
			.poll(() => screen.baseElement.querySelector(".cm-content")?.textContent)
			.toContain("hello");
		const editor = screen.baseElement.querySelector(".cm-content") as HTMLElement;
		editor.focus();
		await userEvent.keyboard("{Control>}{End}{/Control}");
		await userEvent.keyboard(typed);
		await expect.element(screen.getByTestId("file-dirty")).toHaveTextContent("Unsaved changes");
	}

	it("offers no Edit button when the machine does not allow saving", async () => {
		apiMock.readWorkspaceFile.mockResolvedValue(textResult("notes.txt", "hello\n"));
		const screen = mount(["notes.txt"]);
		await open(screen, "notes.txt");
		await expect.element(screen.getByTestId("file-viewer")).toBeVisible();
		expect(screen.baseElement.querySelector('[data-testid="file-edit"]')).toBeNull();
		expect(screen.baseElement.querySelector('[data-testid="file-editor-bar"]')).toBeNull();
	});

	it("edits, marks the file dirty and saves against the revision it read", async () => {
		apiMock.readWorkspaceFile.mockResolvedValue(textResult("notes.txt", "hello"));
		apiMock.writeWorkspaceFile.mockResolvedValue({
			entry: { ...fileEntry("notes.txt"), revision: "r2" },
		});
		const screen = mount(["notes.txt"], true);
		await editNotes(screen, " world");
		await screen.getByTestId("file-save").click();
		await expect.element(screen.getByTestId("file-dirty")).toHaveTextContent("No changes");
		expect(apiMock.writeWorkspaceFile).toHaveBeenCalledWith(
			"d",
			"ws",
			"notes.txt",
			"hello world",
			"r1"
		);
		// The next save goes against the revision the save answered.
		await userEvent.keyboard("!");
		await userEvent.keyboard("{Control>}s{/Control}");
		await expect.poll(() => apiMock.writeWorkspaceFile.mock.calls.length).toBe(2);
		expect(apiMock.writeWorkspaceFile.mock.calls[1]).toEqual([
			"d",
			"ws",
			"notes.txt",
			"hello world!",
			"r2",
		]);
	});

	it("Discard drops the edits and goes back to the file as read", async () => {
		apiMock.readWorkspaceFile.mockResolvedValue(textResult("notes.txt", "hello"));
		const screen = mount(["notes.txt"], true);
		await editNotes(screen, " typo");
		await screen.getByTestId("file-discard").click();
		await expect.element(screen.getByTestId("file-edit")).toBeVisible();
		await expect
			.poll(() => screen.baseElement.querySelector(".cm-content")?.textContent)
			.toBe("hello");
		expect(apiMock.writeWorkspaceFile).not.toHaveBeenCalled();
	});

	it("on a change on disk, Overwrite saves against the revision now on disk", async () => {
		const { FileConflictError } = await import("$lib/codeApi");
		apiMock.readWorkspaceFile.mockResolvedValue(textResult("notes.txt", "hello"));
		apiMock.writeWorkspaceFile
			.mockRejectedValueOnce(new FileConflictError("changed", "r9"))
			.mockResolvedValueOnce({ entry: { ...fileEntry("notes.txt"), revision: "r10" } });
		const screen = mount(["notes.txt"], true);
		await editNotes(screen, " mine");
		await screen.getByTestId("file-save").click();
		await expect.element(screen.getByTestId("file-conflict")).toBeVisible();
		await expect.element(screen.getByText("Changed on disk.")).toBeVisible();
		await screen.getByTestId("file-conflict-overwrite").click();
		await expect.element(screen.getByTestId("file-dirty")).toHaveTextContent("No changes");
		expect(screen.baseElement.querySelector('[data-testid="file-conflict"]')).toBeNull();
		expect(apiMock.writeWorkspaceFile.mock.calls.map((call) => call[4])).toEqual(["r1", "r9"]);
	});

	it("on a change on disk, Reload drops the edits and shows the file on disk", async () => {
		const { FileConflictError } = await import("$lib/codeApi");
		apiMock.readWorkspaceFile
			.mockResolvedValueOnce(textResult("notes.txt", "hello"))
			.mockResolvedValueOnce(textResult("notes.txt", "the agent's version", { revision: "r9" }));
		apiMock.writeWorkspaceFile.mockRejectedValueOnce(new FileConflictError("changed", "r9"));
		const screen = mount(["notes.txt"], true);
		await editNotes(screen, " mine");
		await screen.getByTestId("file-save").click();
		await screen.getByTestId("file-conflict-reload").click();
		await expect
			.poll(() => screen.baseElement.querySelector(".cm-content")?.textContent)
			.toBe("the agent's version");
		await expect.element(screen.getByTestId("file-edit")).toBeVisible();
		expect(apiMock.writeWorkspaceFile).toHaveBeenCalledTimes(1);
	});

	it("keeps large, binary and image files read-only, saying why", async () => {
		apiMock.readWorkspaceFile.mockResolvedValueOnce(
			textResult("big.log", "x", { size: 2 * 1024 * 1024, eof: false })
		);
		const screen = mount(["big.log", "blob.bin", "plot.png"], true);
		await open(screen, "big.log");
		await expect.element(screen.getByText("Files over 1 MiB can't be edited here.")).toBeVisible();
		expect(screen.baseElement.querySelector('[data-testid="file-edit"]')).toBeNull();

		await screen.getByRole("button", { name: "Back to files" }).click();
		apiMock.readWorkspaceFile.mockResolvedValueOnce({
			...textResult("blob.bin", ""),
			kind: "binary",
			encoding: "none",
			content: undefined,
		});
		await open(screen, "blob.bin");
		await expect.element(screen.getByText("Binary files can't be edited here.")).toBeVisible();

		await screen.getByRole("button", { name: "Back to files" }).click();
		apiMock.readWorkspaceFile.mockResolvedValueOnce(imageResult("image/png"));
		await open(screen, "plot.png");
		await expect.element(screen.getByText("Images can't be edited here.")).toBeVisible();
		expect(screen.baseElement.querySelector('[data-testid="file-edit"]')).toBeNull();
	});

	it("asks before leaving unsaved edits, and stays when told to", async () => {
		apiMock.readWorkspaceFile.mockResolvedValue(textResult("notes.txt", "hello"));
		const confirm = vi.fn(() => false);
		vi.stubGlobal("confirm", confirm);
		const screen = mount(["notes.txt"], true);
		await editNotes(screen, " unsaved");

		// Back to the tree: asked, and kept.
		await screen.getByRole("button", { name: "Back to files" }).click();
		expect(confirm).toHaveBeenCalledTimes(1);
		await expect.element(screen.getByTestId("file-dirty")).toHaveTextContent("Unsaved changes");

		// Switching the side pane away, or closing it: asked too.
		sidePane.openFiles();
		sidePane.openTasks();
		expect(confirm).toHaveBeenCalledTimes(2);
		expect(sidePane.view).toBe("files");
		sidePane.close();
		expect(sidePane.open).toBe(true);

		// Navigating away: the guard cancels.
		// The mock is typed with no parameters; the component registered its guard.
		const calls = navigation.beforeNavigate.mock.calls as unknown as Array<
			[(nav: { willUnload: boolean; cancel: () => void }) => void]
		>;
		const guard = calls[calls.length - 1][0];
		const cancel = vi.fn();
		guard({ willUnload: false, cancel });
		expect(cancel).toHaveBeenCalled();

		// Told yes: it leaves.
		confirm.mockReturnValue(true);
		await screen.getByRole("button", { name: "Back to files" }).click();
		await expect.element(screen.getByRole("button", { name: "notes.txt" })).toBeVisible();
		sidePane.reset();
	});
});
