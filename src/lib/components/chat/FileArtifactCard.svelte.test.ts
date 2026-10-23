import FileArtifactCard from "./FileArtifactCard.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { page } from "@vitest/browser/context";
import { cacheFileBytes, clearFileByteCache } from "$lib/utils/execution/fileIdentity";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { ARTIFACTS_CONTEXT_KEY, type ArtifactsContext } from "$lib/utils/artifactsContext";
import type { FileArtifactRegistry } from "$lib/utils/fileArtifacts";

/**
 * The session underneath is a controllable fake; the card under test is real,
 * so download wiring is exercised as shipped.
 */
const sessionMock = vi.hoisted(() => ({
	readFile: vi.fn(async () => new Uint8Array([104, 105]).buffer as ArrayBuffer),
	run: vi.fn(async () => ({ ok: true, stdout: "", stderr: "" })),
	listFiles: vi.fn(async () => []),
}));

vi.mock("$lib/utils/execution/runtime", () => ({
	getExecutionSession: () => sessionMock,
}));

vi.mock("$app/state", () => ({
	page: { data: {}, url: new URL("http://localhost/conversation/c1"), params: { id: "c1" } },
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

	it("renders the same card, without Open, while the sha is not in the registry", async () => {
		const screen = mountCard({
			file: { path: "report.docx", size: 12 },
			sha256: "f".repeat(64),
			downloadUrl: "/conversation/c/code-execution/output/unknown",
		});
		expect(
			screen.baseElement.querySelector('button[aria-label="Open report.docx in panel"]')
		).toBeNull();
		// One design: no second, plain card with its own Preview button.
		expect(screen.baseElement.querySelector('[data-testid="file-artifact-card"]')).not.toBeNull();
		expect(screen.baseElement.querySelector('button[aria-label^="Preview"]')).toBeNull();
		await expect.element(screen.getByText("Word · 12 B")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Download report.docx" }))
			.toBeVisible();
	});

	it("renders a live sandbox path as its name relative to the working directory", async () => {
		const screen = mountCard({ file: { path: "/home/pyodide/notes.txt", size: 25 } });
		await expect.element(screen.getByText("Text · 25 B")).toBeVisible();
		expect(screen.baseElement.querySelector('[data-testid="file-artifact-card"]')).not.toBeNull();
	});

	it("renders the card without an artifacts context", async () => {
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

	it("keeps two files with the same basename in different directories apart", async () => {
		const A = "a".repeat(64);
		const B = "b".repeat(64);
		const registry: FileArtifactRegistry = {
			artifacts: new Map([
				[
					"a/x.pdf",
					{
						name: "a/x.pdf",
						versions: [{ name: "a/x.pdf", size: 5, sha256: A, version: 1, messageId: "m" }],
					},
				],
				[
					"b/x.pdf",
					{
						name: "b/x.pdf",
						versions: [{ name: "b/x.pdf", size: 6, sha256: B, version: 1, messageId: "m" }],
					},
				],
			]),
		};
		const open = vi.spyOn(sidePane, "openArtifact");
		const screen = mountCard(
			{ file: { path: "/home/pyodide/b/x.pdf", size: 6 }, sha256: B },
			registry
		);
		await expect.element(screen.getByText("b/ · PDF · 6 B")).toBeVisible();
		await screen.getByRole("button", { name: "Open x.pdf in panel" }).click();
		expect(open).toHaveBeenCalledWith("b/x.pdf", null);
	});

	it("opens the name the card shows when identical bytes sit under two names", async () => {
		const SAME = "c".repeat(64);
		const registry: FileArtifactRegistry = {
			artifacts: new Map([
				[
					"a.csv",
					{
						name: "a.csv",
						versions: [{ name: "a.csv", size: 5, sha256: SAME, version: 1, messageId: "m" }],
					},
				],
				[
					"b.csv",
					{
						name: "b.csv",
						versions: [{ name: "b.csv", size: 5, sha256: SAME, version: 1, messageId: "m" }],
					},
				],
			]),
		};
		const open = vi.spyOn(sidePane, "openArtifact");
		const screen = mountCard({ file: { path: "b.csv", size: 5 }, sha256: SAME }, registry);
		await screen.getByRole("button", { name: "Open b.csv in panel" }).click();
		expect(open).toHaveBeenCalledWith("b.csv", null);
	});

	it("says a file was not saved instead of offering a dead download", async () => {
		const NS = "d".repeat(64);
		const registry: FileArtifactRegistry = {
			artifacts: new Map([
				[
					"lost.csv",
					{
						name: "lost.csv",
						versions: [
							{
								name: "lost.csv",
								size: 5,
								sha256: NS,
								version: 1,
								messageId: "m",
								uploaded: false,
							},
						],
					},
				],
			]),
		};
		const screen = mountCard({ file: { path: "lost.csv", size: 5 }, sha256: NS }, registry);
		await expect.element(screen.getByTestId("file-not-saved")).toBeVisible();
		await expect
			.element(screen.getByTestId("file-not-saved"))
			.toHaveTextContent(/no longer available/);
		expect(screen.baseElement.querySelector('button[aria-label^="Download"]')).toBeNull();
	});

	it("offers download and a retry while this tab still holds the bytes of an unsaved file", async () => {
		const NS = "e1".repeat(32);
		cacheFileBytes(NS, new Uint8Array([1, 2, 3]));
		const registry: FileArtifactRegistry = {
			artifacts: new Map([
				[
					"kept.csv",
					{
						name: "kept.csv",
						versions: [
							{
								name: "kept.csv",
								size: 3,
								sha256: NS,
								version: 1,
								messageId: "m",
								uploaded: false,
							},
						],
					},
				],
			]),
		};
		const screen = mountCard({ file: { path: "kept.csv", size: 3 }, sha256: NS }, registry);
		await expect.element(screen.getByRole("button", { name: "Download kept.csv" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: /Retry saving/ })).toBeVisible();
		clearFileByteCache();
	});

	it("keeps every character that fits: a name with room is not cut, a long one fills the row", async () => {
		await page.viewport(390, 800);
		const fits = mountCard({
			file: { path: "Cerea_and_Pystino.pptx", size: 31_000 },
			sha256: SHA_V2,
		});
		const whole = fits.baseElement.querySelector('[data-testid="file-name"]') as HTMLElement;
		const wholeHead = whole.firstElementChild as HTMLElement;
		expect(wholeHead.scrollWidth).toBeLessThanOrEqual(wholeHead.clientWidth);
		expect(whole.textContent).toContain("Cerea_and_Pystino.pptx");
		fits.unmount();

		const long = mountCard({
			file: { path: "preview_Cerea_and_Pystino_Overview_final_v2.pptx", size: 31_000 },
			sha256: SHA_V2,
		});
		const el = long.baseElement.querySelector('[data-testid="file-name"]') as HTMLElement;
		const head = el.firstElementChild as HTMLElement;
		const tail = el.lastElementChild as HTMLElement;
		expect(head.scrollWidth).toBeGreaterThan(head.clientWidth);
		// Head plus pinned tail use the whole name column: nothing is left empty.
		expect(
			Math.abs(
				head.getBoundingClientRect().width +
					tail.getBoundingClientRect().width -
					el.getBoundingClientRect().width
			)
		).toBeLessThan(2);
		// Only the extension and two characters are pinned.
		expect(tail.textContent).toBe("v2.pptx".slice(-7));
	});

	it("middle-truncates a long name keeping the extension, at phone width", async () => {
		await page.viewport(390, 800);
		const name = "preview_Cerea_and_Pystino_Overview_final.pptx";
		const screen = mountCard({ file: { path: name, size: 31_000 }, sha256: SHA_V2 });
		const el = screen.baseElement.querySelector('[data-testid="file-name"]') as HTMLElement;
		expect(el.getAttribute("title")).toBe(name);
		expect(el.textContent).toContain("final.pptx".slice(-9));
		// One line: never the mid-word wrap of the old design.
		const head = el.firstElementChild as HTMLElement;
		expect(head.scrollWidth).toBeGreaterThan(head.clientWidth);
		expect(el.getBoundingClientRect().height).toBeLessThan(26);
		// Icon-only actions below 520px keep their accessible names.
		const open = screen.baseElement.querySelector('button[aria-label^="Download"]') as HTMLElement;
		expect(open.innerText.trim()).toBe("");
	});

	it("downloads from the persisted store", async () => {
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

describe("FileArtifactCard autoExpand (the chat figure capture)", () => {
	const FIG_SHA = "f".repeat(64);
	const SVG_SHA = "e".repeat(64);
	const pngBytes = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;

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
			[
				"fig.svg",
				{
					name: "fig.svg",
					versions: [{ name: "fig.svg", size: 8, sha256: SVG_SHA, version: 1, messageId: "m1" }],
				},
			],
		]),
	};

	it("shows a raster figure under an unresolved file too", async () => {
		sessionMock.readFile.mockResolvedValueOnce(pngBytes() as ArrayBuffer);
		const screen = mountCard(
			{ file: { path: "/home/pyodide/figure-1.png", size: 8 }, autoExpand: true },
			figureRegistry
		);
		await expect
			.element(screen.getByRole("img", { name: "Preview of figure-1.png" }))
			.toBeVisible();
	});

	it("shows a resolved raster artifact as an image under its header", async () => {
		const realFetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(pngBytes()))
		);
		try {
			const screen = mountCard(
				{
					file: { path: "figure-1.png", size: 8 },
					sha256: FIG_SHA,
					downloadUrl: "/conversation/c/code-execution/output/x",
					autoExpand: true,
				},
				figureRegistry
			);
			// The artifact header is above the image.
			await expect.element(screen.getByText("figure-1.png")).toBeVisible();
			await expect
				.element(screen.getByRole("img", { name: "Preview of figure-1.png" }))
				.toBeVisible();
		} finally {
			vi.stubGlobal("fetch", realFetch);
		}
	});

	it("leaves a resolved raster artifact image-free without the flag", async () => {
		const fetch = vi.fn(async () => new Response(pngBytes()));
		const realFetch = globalThis.fetch;
		vi.stubGlobal("fetch", fetch);
		try {
			const screen = mountCard(
				{
					file: { path: "figure-1.png", size: 8 },
					sha256: FIG_SHA,
					downloadUrl: "/conversation/c/code-execution/output/x",
				},
				figureRegistry
			);
			await expect.element(screen.getByText("figure-1.png")).toBeVisible();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(screen.baseElement.querySelector("img")).toBeNull();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			vi.stubGlobal("fetch", realFetch);
		}
	});

	it("never renders an SVG artifact inline, however the flag is set", async () => {
		const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]).buffer));
		const realFetch = globalThis.fetch;
		vi.stubGlobal("fetch", fetch);
		try {
			const screen = mountCard(
				{
					file: { path: "fig.svg", size: 3 },
					sha256: SVG_SHA,
					downloadUrl: "/conversation/c/code-execution/output/y",
					autoExpand: true,
				},
				figureRegistry
			);
			await expect.element(screen.getByText("fig.svg")).toBeVisible();
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(screen.baseElement.querySelector("img")).toBeNull();
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			vi.stubGlobal("fetch", realFetch);
		}
	});
});
