import FileCard from "./FileCard.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The session underneath is a controllable fake; the card under test is real,
 * so download wiring and preview expansion are exercised as shipped.
 */
const sessionMock = vi.hoisted(() => ({
	readFile: vi.fn(async (_path: string) => new Uint8Array([104, 105]).buffer as ArrayBuffer),
	run: vi.fn(async (_code: string) => ({ ok: true, stdout: "", stderr: "" })),
}));

vi.mock("$lib/utils/execution/runtime", () => ({
	getExecutionSession: () => sessionMock,
}));

const textBytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

beforeEach(() => {
	sessionMock.readFile.mockClear();
	sessionMock.run.mockClear();
	sessionMock.readFile.mockImplementation(
		async () => new Uint8Array([104, 105]).buffer as ArrayBuffer
	);
});

describe("FileCard", () => {
	it("names the file with its size and a download", async () => {
		const screen = render(FileCard, { file: { path: "/home/pyodide/report.docx", size: 2916 } });
		await expect.element(screen.getByText("report.docx")).toBeVisible();
		await expect.element(screen.getByText("2.8 KB")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Download report.docx" }))
			.toBeVisible();
		// A Word document offers a preview, not just the download.
		await expect.element(screen.getByRole("button", { name: "Preview report.docx" })).toBeVisible();
	});

	it("pulls the bytes out of the sandbox on download", async () => {
		const screen = render(FileCard, { file: { path: "/home/pyodide/a.txt", size: 2 } });
		await screen.getByRole("button", { name: "Download a.txt" }).click();
		await vi.waitFor(() =>
			expect(sessionMock.readFile).toHaveBeenCalledWith("/home/pyodide/a.txt")
		);
	});

	it("shows a worker refusal instead of failing silently", async () => {
		sessionMock.readFile.mockRejectedValueOnce(
			new Error("only /home/pyodide files can be downloaded")
		);
		const screen = render(FileCard, { file: { path: "/etc/passwd", size: 8 } });
		await screen.getByRole("button", { name: "Download passwd" }).click();
		await expect
			.element(screen.getByText("only /home/pyodide files can be downloaded"))
			.toBeVisible();
	});

	it("previews text in place", async () => {
		sessionMock.readFile.mockResolvedValueOnce(textBytes("hello preview\nsecond line"));
		const screen = render(FileCard, { file: { path: "/home/pyodide/notes.txt", size: 25 } });
		await screen.getByRole("button", { name: "Preview notes.txt" }).click();
		await expect.element(screen.getByText("hello preview")).toBeVisible();
	});

	it("offers no preview for types it cannot render", async () => {
		const screen = render(FileCard, { file: { path: "/home/pyodide/data.bin", size: 16 } });
		await expect.element(screen.getByRole("button", { name: "Download data.bin" })).toBeVisible();
		expect(screen.baseElement.querySelector('button[aria-label="Preview data.bin"]')).toBeNull();
	});
});

describe("FileCard direct-emission mode (inline bytes)", () => {
	/**
	 * The inline mode backs titled file blocks: the bytes are the message's
	 * own text and no sandbox exists in that context. Both spies must be
	 * restored — a leaked prototype spy would swallow other tests' clicks.
	 */
	function spyDownload() {
		const blobs: Blob[] = [];
		const createObjectURL = vi
			.spyOn(URL, "createObjectURL")
			.mockImplementation((blob: Blob | MediaSource) => {
				blobs.push(blob as Blob);
				return "blob:mock";
			});
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		return {
			blobs,
			click,
			restore: () => {
				createObjectURL.mockRestore();
				click.mockRestore();
			},
		};
	}

	it("downloads the exact inline bytes without touching the sandbox", async () => {
		const spy = spyDownload();
		try {
			const screen = render(FileCard, {
				file: { path: "report.md", size: 0 },
				inlineContent: "# Hello\n\nWorld",
			});
			await screen.getByRole("button", { name: "Download report.md" }).click();
			await vi.waitFor(() => expect(spy.click).toHaveBeenCalled());
			const anchor = spy.click.mock.contexts[0] as HTMLAnchorElement;
			expect(anchor.download).toBe("report.md");
			expect(await spy.blobs[0].text()).toBe("# Hello\n\nWorld");
			// Zero execution: the runtime is never consulted for inline bytes.
			expect(sessionMock.readFile).not.toHaveBeenCalled();
		} finally {
			spy.restore();
		}
	});

	it("shows the derived byte size, not the ignored file.size", async () => {
		const screen = render(FileCard, {
			file: { path: "report.md", size: 0 },
			inlineContent: "# Hello\n\nWorld",
		});
		// "# Hello\n\nWorld" is 14 UTF-8 bytes.
		await expect.element(screen.getByText("14 B")).toBeVisible();
	});

	it("previews inline text in place, still without the sandbox", async () => {
		const screen = render(FileCard, {
			file: { path: "report.md", size: 0 },
			inlineContent: "# Hello\n\nWorld",
		});
		await screen.getByRole("button", { name: "Preview report.md" }).click();
		await expect.element(screen.getByText("# Hello")).toBeVisible();
		expect(sessionMock.readFile).not.toHaveBeenCalled();
	});

	it("offers no docx preview for inline content (that one runs Python)", async () => {
		const screen = render(FileCard, {
			file: { path: "file.docx", size: 0 },
			inlineContent: "not a zip",
		});
		await expect.element(screen.getByRole("button", { name: "Download file.docx" })).toBeVisible();
		expect(screen.baseElement.querySelector('button[aria-label="Preview file.docx"]')).toBeNull();
		expect(sessionMock.run).not.toHaveBeenCalled();
	});
});
