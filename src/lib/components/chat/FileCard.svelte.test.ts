import FileCard from "./FileCard.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderAsync } from "docx-preview";
import { sidePane } from "$lib/stores/sidePane.svelte";

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

// The renderer is a real dependency with its own upstream tests; what is
// under test here is the wiring — bytes in, sanitized panel payload out —
// so the module boundary is mocked, not the zip format. The real renderer
// fills a live element; the mock plays that part minimally.
vi.mock("docx-preview", () => ({
	renderAsync: vi.fn(async (_data: Blob, container: HTMLElement) => {
		container.innerHTML = '<section class="docx-wrapper"><h1>Hi</h1></section>';
	}),
}));

const textBytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

beforeEach(() => {
	sessionMock.readFile.mockClear();
	sessionMock.run.mockClear();
	sessionMock.readFile.mockImplementation(
		async () => new Uint8Array([104, 105]).buffer as ArrayBuffer
	);
	vi.mocked(renderAsync).mockClear();
	vi.mocked(renderAsync).mockImplementation(async (_data: Blob, container: HTMLElement) => {
		container.innerHTML = '<section class="docx-wrapper"><h1>Hi</h1></section>';
	});
	// sidePane is a module singleton: a preview left open by one test would
	// leak into the next one's assertions.
	sidePane.reset();
});

describe("FileCard", () => {
	it("names the file with its size and a download", async () => {
		const screen = render(FileCard, { file: { path: "/home/pyodide/report.docx", size: 2916 } });
		await expect.element(screen.getByText("report.docx")).toBeVisible();
		// Two copies of the size exist in the DOM (inline, and under the name
		// for a narrow container — see FileCard's own comment); the inline one
		// renders second and is the one visible at this test's (unconstrained,
		// wide) render width.
		await expect.element(screen.getByText("2.8 KB").last()).toBeVisible();
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

describe("FileCard autoExpand (the chat figure capture)", () => {
	const pngBytes = () =>
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer as ArrayBuffer;

	it("opens a raster image without waiting for the Preview click", async () => {
		sessionMock.readFile.mockResolvedValueOnce(pngBytes());
		const screen = render(FileCard, {
			file: { path: "/home/pyodide/figure-1.png", size: 1234 },
			autoExpand: true,
		});
		// The card header stays above the image.
		await expect.element(screen.getByText("figure-1.png")).toBeVisible();
		await expect
			.element(screen.getByRole("img", { name: "Preview of figure-1.png" }))
			.toBeVisible();
		await vi.waitFor(() =>
			expect(sessionMock.readFile).toHaveBeenCalledWith("/home/pyodide/figure-1.png")
		);
	});

	it("leaves a raster image closed without the flag", async () => {
		const screen = render(FileCard, { file: { path: "/home/pyodide/figure-1.png", size: 1234 } });
		await expect.element(screen.getByText("figure-1.png")).toBeVisible();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.baseElement.querySelector("img")).toBeNull();
		expect(sessionMock.readFile).not.toHaveBeenCalled();
		// The manual preview still works as before.
		await expect
			.element(screen.getByRole("button", { name: "Preview figure-1.png" }))
			.toBeVisible();
	});

	it("never expands an SVG, however the flag is set", async () => {
		const screen = render(FileCard, {
			file: { path: "/home/pyodide/fig.svg", size: 100 },
			autoExpand: true,
		});
		await expect.element(screen.getByText("fig.svg")).toBeVisible();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.baseElement.querySelector("img")).toBeNull();
		expect(sessionMock.readFile).not.toHaveBeenCalled();
		// An SVG stays a file card: the manual preview is still offered.
		await expect.element(screen.getByRole("button", { name: "Preview fig.svg" })).toBeVisible();
	});

	it("never expands text, however the flag is set", async () => {
		const screen = render(FileCard, {
			file: { path: "/home/pyodide/notes.txt", size: 25 },
			autoExpand: true,
		});
		await expect.element(screen.getByText("notes.txt")).toBeVisible();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(screen.baseElement.querySelector("pre")).toBeNull();
		expect(sessionMock.readFile).not.toHaveBeenCalled();
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
		// "# Hello\n\nWorld" is 14 UTF-8 bytes. Two copies of the size exist in
		// the DOM (inline, and under the name for a narrow container); the
		// inline one renders second and is the one visible at this test's
		// (unconstrained, wide) render width.
		await expect.element(screen.getByText("14 B").last()).toBeVisible();
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

	it("offers no docx preview for inline content (inline content is text, not a zip)", async () => {
		const screen = render(FileCard, {
			file: { path: "file.docx", size: 0 },
			inlineContent: "not a zip",
		});
		await expect.element(screen.getByRole("button", { name: "Download file.docx" })).toBeVisible();
		expect(screen.baseElement.querySelector('button[aria-label="Preview file.docx"]')).toBeNull();
		expect(sessionMock.readFile).not.toHaveBeenCalled();
	});

	it("renders a sandbox docx as formatted HTML in the side panel, never Python", async () => {
		const screen = render(FileCard, { file: { path: "/home/pyodide/report.docx", size: 2916 } });
		await screen.getByRole("button", { name: "Preview report.docx" }).click();
		await vi.waitFor(() => expect(sidePane.open).toBe(true));
		expect(sidePane.view).toBe("preview");
		expect(sidePane.preview).toMatchObject({ kind: "html", title: "report.docx" });
		expect(sidePane.preview?.content).toContain("<h1>Hi</h1>");
		// The converter read fetched bytes; the sandbox Python path is gone.
		expect(sessionMock.run).not.toHaveBeenCalled();
		// No inline expander opens for a document preview — the panel owns it.
		expect(screen.baseElement.querySelector("pre")).toBeNull();
	});

	it("renders a persisted docx from its download URL — previews survive reload", async () => {
		const realFetch = globalThis.fetch;
		const fetch = vi.fn(async () => new Response(new Uint8Array([80, 75, 3, 4]).buffer));
		vi.stubGlobal("fetch", fetch);
		try {
			const screen = render(FileCard, {
				file: { path: "report.docx", size: 4 },
				downloadUrl: "/conversation/abc/code-execution/output/sha256",
			});
			// The persisted path offers the same Preview button the live path does.
			await expect
				.element(screen.getByRole("button", { name: "Preview report.docx" }))
				.toBeVisible();
			await screen.getByRole("button", { name: "Preview report.docx" }).click();
			await vi.waitFor(() => expect(sidePane.open).toBe(true));
			expect(fetch).toHaveBeenCalledWith("/conversation/abc/code-execution/output/sha256");
			expect(vi.mocked(renderAsync)).toHaveBeenCalled();
			expect(sidePane.preview).toMatchObject({ kind: "html", title: "report.docx" });
		} finally {
			vi.stubGlobal("fetch", realFetch);
		}
	});

	it("sanitizes the rendered document before paneling it", async () => {
		vi.mocked(renderAsync).mockImplementation(async (_data: Blob, container: HTMLElement) => {
			container.innerHTML = '<h1>Hi</h1><script>alert("x")</script>';
		});
		const screen = render(FileCard, { file: { path: "/home/pyodide/report.docx", size: 2916 } });
		await screen.getByRole("button", { name: "Preview report.docx" }).click();
		await vi.waitFor(() => expect(sidePane.open).toBe(true));
		expect(sidePane.preview?.content).toContain("<h1>Hi</h1>");
		expect(sidePane.preview?.content).not.toContain("<script>");
	});

	it("refuses an oversized docx with the download left working", async () => {
		const big = new Uint8Array(8 * 1024 * 1024 + 1);
		const realFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(big.buffer))
		);
		try {
			const screen = render(FileCard, {
				file: { path: "report.docx", size: big.length },
				downloadUrl: "/conversation/abc/code-execution/output/sha256",
			});
			await screen.getByRole("button", { name: "Preview report.docx" }).click();
			await expect
				.element(screen.getByText("too large to preview", { exact: false }))
				.toBeVisible();
			expect(sidePane.open).toBe(false);
			expect(vi.mocked(renderAsync)).not.toHaveBeenCalled();
			await expect
				.element(screen.getByRole("button", { name: "Download report.docx" }))
				.toBeVisible();
		} finally {
			vi.stubGlobal("fetch", realFetch);
		}
	});

	it("shows a rendering failure inline with the download intact", async () => {
		vi.mocked(renderAsync).mockRejectedValue(new Error("not a zip"));
		const screen = render(FileCard, { file: { path: "/home/pyodide/report.docx", size: 2916 } });
		await screen.getByRole("button", { name: "Preview report.docx" }).click();
		await expect.element(screen.getByText("not a zip")).toBeVisible();
		expect(sidePane.open).toBe(false);
		await expect
			.element(screen.getByRole("button", { name: "Download report.docx" }))
			.toBeVisible();
	});

	it("opens a pdf in the side panel as a typed data URL, never inline", async () => {
		// The bytes travel whole (the viewer needs every byte) and typed:
		// a typeless blob navigated in a frame downloads instead of
		// rendering, which was the blank-frame-plus-download failure.
		const screen = render(FileCard, { file: { path: "/home/pyodide/report.pdf", size: 1024 } });
		await screen.getByRole("button", { name: "Preview report.pdf" }).click();
		await vi.waitFor(() => expect(sidePane.open).toBe(true));
		expect(sidePane.view).toBe("preview");
		expect(sidePane.preview).toMatchObject({ kind: "pdf", title: "report.pdf" });
		expect(sidePane.preview?.content.startsWith("data:application/pdf;base64,")).toBe(true);
		// No inline expander opens for a document preview — the panel owns it.
		expect(screen.baseElement.querySelector("iframe")).toBeNull();
		expect(sessionMock.run).not.toHaveBeenCalled();
	});

	it("refuses an oversized pdf with the download left working", async () => {
		const big = new Uint8Array(8 * 1024 * 1024 + 1);
		sessionMock.readFile.mockResolvedValue(big.buffer as ArrayBuffer);
		const screen = render(FileCard, {
			file: { path: "/home/pyodide/report.pdf", size: big.length },
		});
		await screen.getByRole("button", { name: "Preview report.pdf" }).click();
		await expect.element(screen.getByText("too large to preview", { exact: false })).toBeVisible();
		expect(sidePane.open).toBe(false);
		await expect.element(screen.getByRole("button", { name: "Download report.pdf" })).toBeVisible();
	});

	it("refuses an oversized text file even though the recorded size is small", async () => {
		// `size` is the metadata passed in as a prop, not the bytes themselves —
		// this recreates a caller under-reporting it, the same gap the pdf/docx
		// checks above already close on their own byte read.
		const big = new Uint8Array(8 * 1024 * 1024 + 1);
		sessionMock.readFile.mockResolvedValue(big.buffer as ArrayBuffer);
		const screen = render(FileCard, {
			file: { path: "/home/pyodide/notes.txt", size: 10 },
		});
		await screen.getByRole("button", { name: "Preview notes.txt" }).click();
		await expect.element(screen.getByText("too large to preview", { exact: false })).toBeVisible();
		expect(screen.baseElement.querySelector("pre")).toBeNull();
	});
});
