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
	uploadWorkspaceFile: vi.fn(),
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
	uploadWorkspaceFile: apiMock.uploadWorkspaceFile,
	listWorkspaceFiles: apiMock.listWorkspaceFiles,
	readWorkspaceFile: apiMock.readWorkspaceFile,
	workspaceFileStatus: apiMock.workspaceFileStatus,
	workspaceFileDownloadUrl: (_d: string, _w: string, path: string) =>
		`/api/v2/code/v1/workspaces/ws/files/download?device=d&path=${encodeURIComponent(path)}`,
	workspaceFileZipUrl: (_d: string, _w: string, path: string) =>
		`/api/v2/code/v1/workspaces/ws/files/zip?device=d&path=${encodeURIComponent(path)}`,
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

	it("undoes and redoes edits with the standard keys", async () => {
		apiMock.readWorkspaceFile.mockResolvedValue(textResult("notes.txt", "hello"));
		const screen = mount(["notes.txt"], true);
		await editNotes(screen, " world");
		const text = () => screen.baseElement.querySelector(".cm-content")?.textContent;
		await userEvent.keyboard("{Control>}z{/Control}");
		await expect.poll(text).toBe("hello");
		await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
		await expect.poll(text).toBe("hello world");
		expect(apiMock.writeWorkspaceFile).not.toHaveBeenCalled();
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

describe("CodeFiles upload", () => {
	function mountUpload(uploadable: boolean, names = ["a.txt"]) {
		apiMock.listWorkspaceFiles.mockResolvedValue({
			path: ".",
			entries: names.map(fileEntry),
			truncated: false,
		});
		apiMock.workspaceFileStatus.mockResolvedValue({ isGitRepo: false, entries: [] });
		return render(CodeFiles, { deviceId: "d", workspaceId: "ws", writable: true, uploadable });
	}
	type Screen = ReturnType<typeof mountUpload>;
	const withPath = (file: File, rel: string) => {
		Object.defineProperty(file, "webkitRelativePath", { value: rel });
		return file;
	};
	const pick = (screen: Screen, files: File[], testid = "file-upload-input") => {
		const input = screen.getByTestId(testid).element() as HTMLInputElement;
		const data = new DataTransfer();
		for (const f of files) data.items.add(f);
		input.files = data.files;
		input.dispatchEvent(new Event("change", { bubbles: true }));
	};
	const calls = () =>
		apiMock.uploadWorkspaceFile.mock.calls.map((c) => [c[2], c[3], c[4].name, c[5].overwrite]);

	beforeEach(() => {
		apiMock.uploadWorkspaceFile.mockReset();
		apiMock.uploadWorkspaceFile.mockResolvedValue({ entry: fileEntry("x") });
	});

	it("shows no Upload, Upload folder or drop without the capability", async () => {
		const screen = mountUpload(false);
		await expect.element(screen.getByText("a.txt")).toBeVisible();
		expect(screen.getByTestId("file-upload").elements()).toHaveLength(0);
		expect(screen.getByTestId("folder-upload").elements()).toHaveLength(0);
		const data = new DataTransfer();
		data.items.add(new File(["x"], "dropped.txt"));
		screen
			.getByTestId("file-drop-zone")
			.element()
			.dispatchEvent(
				new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true })
			);
		expect(apiMock.uploadWorkspaceFile).not.toHaveBeenCalled();
	});

	it("uploads several chosen files into the folder shown, then refreshes the list", async () => {
		const screen = mountUpload(true);
		await expect.element(screen.getByTestId("file-upload")).toBeVisible();
		const listed = apiMock.listWorkspaceFiles.mock.calls.length;
		pick(screen, [new File(["1"], "one.bin"), new File(["2"], "two.bin")]);
		await expect.element(screen.getByText("Uploaded 2 files")).toBeVisible();
		expect(calls()).toEqual([
			[".", "one.bin", "one.bin", false],
			[".", "two.bin", "two.bin", false],
		]);
		expect(apiMock.listWorkspaceFiles.mock.calls.length).toBeGreaterThan(listed);
	});

	it("takes files dropped on the list", async () => {
		const screen = mountUpload(true);
		await expect.element(screen.getByText("a.txt")).toBeVisible();
		const data = new DataTransfer();
		data.items.add(new File(["x"], "dropped.png"));
		screen
			.getByTestId("file-drop-zone")
			.element()
			.dispatchEvent(
				new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true })
			);
		await expect.element(screen.getByText("Uploaded dropped.png")).toBeVisible();
	});

	it("uploads a picked folder with its relative structure, asking galopin to make the folders", async () => {
		const screen = mountUpload(true);
		await expect.element(screen.getByTestId("folder-upload")).toBeVisible();
		pick(
			screen,
			[
				withPath(new File(["1"], "a.txt"), "proj/a.txt"),
				withPath(new File(["2"], "b.txt"), "proj/sub/deep/b.txt"),
			],
			"folder-upload-input"
		);
		await expect.element(screen.getByText("Uploaded 2 files")).toBeVisible();
		expect(calls()).toEqual([
			[".", "proj/a.txt", "a.txt", false],
			[".", "proj/sub/deep/b.txt", "b.txt", false],
		]);
		expect(apiMock.uploadWorkspaceFile.mock.calls.every((c) => c[5].mkdirs === true)).toBe(true);
	});

	it("asks once for the whole batch: Skip existing uploads only the new files", async () => {
		const screen = mountUpload(true, ["a.txt", "b.txt"]);
		await expect.element(screen.getByTestId("file-upload")).toBeVisible();
		pick(screen, [new File(["1"], "a.txt"), new File(["2"], "b.txt"), new File(["3"], "c.txt")]);
		const ask = screen.getByTestId("upload-conflicts");
		await expect.element(ask).toHaveTextContent("2 files already exist.");
		expect(apiMock.uploadWorkspaceFile).not.toHaveBeenCalled();
		await screen.getByTestId("conflict-skip").click();
		await expect
			.element(screen.getByText(/Uploaded 1 of 3 files; 0 failed, 2 skipped/))
			.toBeVisible();
		expect(calls()).toEqual([[".", "c.txt", "c.txt", false]]);
	});

	it("Replace all overwrites exactly the files that exist, and Cancel sends nothing", async () => {
		const screen = mountUpload(true, ["a.txt"]);
		await expect.element(screen.getByTestId("file-upload")).toBeVisible();
		pick(screen, [new File(["1"], "a.txt"), new File(["2"], "new.txt")]);
		await expect
			.element(screen.getByTestId("upload-conflicts"))
			.toHaveTextContent("a.txt already exists.");
		await screen.getByTestId("conflict-replace").click();
		await expect.element(screen.getByText("Uploaded 2 files")).toBeVisible();
		expect(calls()).toEqual([
			[".", "a.txt", "a.txt", true],
			[".", "new.txt", "new.txt", false],
		]);
		apiMock.uploadWorkspaceFile.mockClear();
		pick(screen, [new File(["1"], "a.txt")]);
		await screen.getByTestId("conflict-cancel").click();
		await expect.element(screen.getByText(/Upload cancelled after 0 of 1 files/)).toBeVisible();
		expect(apiMock.uploadWorkspaceFile).not.toHaveBeenCalled();
	});

	it("never overwrites a file that appeared meanwhile: it is listed as not replaced", async () => {
		const { FileConflictError } = await import("$lib/codeApi");
		apiMock.uploadWorkspaceFile.mockRejectedValue(new FileConflictError("exists", null));
		const screen = mountUpload(true, []);
		await expect.element(screen.getByTestId("file-upload")).toBeVisible();
		pick(screen, [new File(["1"], "raced.txt")]);
		await expect
			.element(screen.getByText("raced.txt already exists, and was not replaced."))
			.toBeVisible();
	});

	it("shows a failure on its own line, and refuses a file over 200 MB without sending it", async () => {
		apiMock.uploadWorkspaceFile.mockRejectedValue(new Error("hidden by this machine's policy"));
		const screen = mountUpload(true, []);
		await expect.element(screen.getByTestId("file-upload")).toBeVisible();
		pick(screen, [new File(["1"], "id_rsa")]);
		await expect.element(screen.getByText("id_rsa: hidden by this machine's policy")).toBeVisible();
		const big = new File([new Uint8Array(1)], "big.iso");
		Object.defineProperty(big, "size", { value: 201 * 1024 * 1024 });
		apiMock.uploadWorkspaceFile.mockClear();
		pick(screen, [big]);
		await expect.element(screen.getByText("big.iso is over 200 MB.")).toBeVisible();
		expect(apiMock.uploadWorkspaceFile).not.toHaveBeenCalled();
	});

	it("refuses a folder with more than 5,000 files, saying the limit", async () => {
		const screen = mountUpload(true, []);
		await expect.element(screen.getByTestId("file-upload")).toBeVisible();
		pick(
			screen,
			Array.from({ length: 5001 }, (_, i) => withPath(new File([""], `f${i}`), `big/f${i}`)),
			"folder-upload-input"
		);
		await expect
			.element(screen.getByText("That is 5,001 files; at most 5,000 can be uploaded at once."))
			.toBeVisible();
		expect(apiMock.uploadWorkspaceFile).not.toHaveBeenCalled();
	});

	it("reports progress from the chunks sent, and Cancel stops the upload", async () => {
		let release: () => void = () => {};
		apiMock.uploadWorkspaceFile.mockImplementation(
			async (
				_d: string,
				_w: string,
				_dir: string,
				_rel: string,
				_f: File,
				opts: { signal: AbortSignal; onProgress: (s: number, t: number) => void }
			) => {
				opts.onProgress(50, 100);
				await new Promise<void>((resolve, reject) => {
					release = resolve;
					opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
				});
				return { entry: fileEntry("x") };
			}
		);
		const screen = mountUpload(true, []);
		await expect.element(screen.getByTestId("file-upload")).toBeVisible();
		pick(screen, [new File([new Uint8Array(100)], "slow.bin")]);
		await expect.element(screen.getByText("Uploading slow.bin… 50%")).toBeVisible();
		await screen.getByRole("button", { name: "Cancel" }).click();
		await expect.element(screen.getByText(/Upload cancelled after 0 of 1 files/)).toBeVisible();
		release();
	});
});

describe("CodeFiles folder download", () => {
	function mountZip(folderDownloadable: boolean) {
		apiMock.listWorkspaceFiles.mockResolvedValue({
			path: ".",
			entries: [{ ...fileEntry("src"), type: "dir" }],
			truncated: false,
		});
		apiMock.workspaceFileStatus.mockResolvedValue({ isGitRepo: false, entries: [] });
		return render(CodeFiles, { deviceId: "d", workspaceId: "ws", folderDownloadable });
	}

	it("offers Download as zip on folder rows and for the open folder, only with the capability", async () => {
		const off = mountZip(false);
		await expect.element(off.getByText("src")).toBeVisible();
		expect(off.getByTestId("folder-zip-row").elements()).toHaveLength(0);
		expect(off.getByTestId("folder-zip").elements()).toHaveLength(0);
		off.unmount();
		const on = mountZip(true);
		await expect
			.element(on.getByTestId("folder-zip-row"))
			.toHaveAttribute("href", expect.stringContaining("/files/zip?device=d&path=src"));
		await expect
			.element(on.getByTestId("folder-zip"))
			.toHaveAttribute("href", expect.stringContaining("/files/zip?device=d&path=."));
	});
});

describe("CodeFiles download", () => {
	function mountDownload(downloadable: boolean) {
		apiMock.listWorkspaceFiles.mockResolvedValue({
			path: ".",
			entries: [fileEntry("a.bin")],
			truncated: false,
		});
		apiMock.workspaceFileStatus.mockResolvedValue({ isGitRepo: false, entries: [] });
		return render(CodeFiles, { deviceId: "d", workspaceId: "ws", downloadable });
	}

	it("offers a Download link per file, to the download route, only with the capability", async () => {
		const off = mountDownload(false);
		await expect.element(off.getByText("a.bin")).toBeVisible();
		expect(off.getByTestId("file-download").elements()).toHaveLength(0);
		off.unmount();
		const on = mountDownload(true);
		const link = on.getByTestId("file-download");
		await expect.element(link).toHaveAttribute("download", "a.bin");
		await expect
			.element(link)
			.toHaveAttribute("href", expect.stringContaining("/files/download?device=d&path=a.bin"));
	});

	it("has a Download button in the open-file view too", async () => {
		apiMock.readWorkspaceFile.mockResolvedValue({
			path: "a.bin",
			revision: "r1",
			size: 8,
			offset: 0,
			length: 0,
			eof: true,
			kind: "binary",
			mime: "application/octet-stream",
			encoding: "none",
		});
		const screen = mountDownload(true);
		await screen.getByText("a.bin").click();
		await expect.element(screen.getByTestId("file-download-open")).toBeVisible();
	});
});
