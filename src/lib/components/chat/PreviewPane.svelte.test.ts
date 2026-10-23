/* eslint-disable @typescript-eslint/no-non-null-assertion -- assertions on values the test just created */
import PreviewPane from "./PreviewPane.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { minimalPdfDataUrl } from "$lib/utils/minimalPdf";

beforeEach(() => {
	sidePane.reset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const iframeSrcdoc = (base: HTMLElement): string | null =>
	base.querySelector('iframe[title^="Preview of"]')?.getAttribute("srcdoc") ?? null;

describe("PreviewPane", () => {
	it("renders nothing without a preview payload", async () => {
		const screen = render(PreviewPane, {});
		await tick();
		expect(screen.baseElement.querySelector("iframe")).toBeNull();
	});

	it("renders an html payload in a sandboxed iframe with its title", async () => {
		sidePane.openPreview({
			kind: "html",
			title: "index.html",
			content: "<!DOCTYPE html><html><body><h1>Hi</h1></body></html>",
		});
		const screen = render(PreviewPane, {});
		await tick();
		await expect.element(screen.getByText("index.html")).toBeVisible();
		const srcdoc = iframeSrcdoc(screen.baseElement);
		expect(srcdoc).not.toBeNull();
		expect(srcdoc).toContain("<h1>Hi</h1>");
		// Same sandbox discipline as every other preview surface.
		expect(screen.baseElement.querySelector("iframe")?.getAttribute("sandbox")).toContain(
			"allow-scripts"
		);
		expect(screen.baseElement.querySelector("iframe")?.getAttribute("sandbox")).not.toContain(
			"allow-same-origin"
		);
	});

	it("renders a mermaid payload through the diagram builder", async () => {
		sidePane.openPreview({
			kind: "mermaid",
			title: "Preview",
			content: "flowchart LR\n    A --> B",
		});
		const screen = render(PreviewPane, {});
		await tick();
		const srcdoc = iframeSrcdoc(screen.baseElement);
		expect(srcdoc).not.toBeNull();
		expect(srcdoc).toContain("mermaid");
		expect(srcdoc).toContain("flowchart LR");
	});

	it("builds a docx payload with the docx srcdoc, not the generic html builder", async () => {
		sidePane.openPreview({
			kind: "docx",
			title: "section.docx",
			content: '<div class="docx-wrapper"><section class="docx"><p>Hi</p></section></div>',
		});
		const screen = render(PreviewPane, {});
		await tick();
		const srcdoc = iframeSrcdoc(screen.baseElement);
		expect(srcdoc).not.toBeNull();
		// The fit-to-width script rides along — the marker string exists only
		// in buildDocxFitScript, so its presence proves the docx builder ran
		// rather than the generic html one.
		expect(srcdoc).toContain("section.docx");
		// The same postMessage hook every preview carries, so error
		// forwarding keeps working through the docx path too.
		expect(srcdoc).toContain("chatui.preview.error");
		// The document's own (already-sanitized) markup is the body.
		expect(srcdoc).toContain('<section class="docx"><p>Hi</p></section>');
		// Same sandbox discipline as every other preview surface.
		expect(screen.baseElement.querySelector("iframe")?.getAttribute("sandbox")).toContain(
			"allow-scripts"
		);
	});

	it(
		"draws a pdf payload in the page with pdf.js, never in a frame",
		{ timeout: 60_000 },
		async () => {
			sidePane.openPreview({ kind: "pdf", title: "report.pdf", content: minimalPdfDataUrl(2) });
			const screen = render(PreviewPane, {});
			await vi.waitFor(
				() => expect(screen.baseElement.querySelectorAll('canvas[role="img"]').length).toBe(2),
				{ timeout: 30_000 }
			);
			expect(screen.baseElement.querySelector("iframe")).toBeNull();
			expect(screen.baseElement.textContent).toContain("2 pages");
			// The canvas holds real pixels: the page was drawn, not just allocated.
			const canvas = screen.baseElement.querySelector("canvas") as HTMLCanvasElement;
			const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
			expect(data.some((v, i) => i % 4 !== 3 && v < 128)).toBe(true);
		}
	);

	it(
		"draws the same pdf the same way on a phone, with new-tab as a secondary action",
		{ timeout: 60_000 },
		async () => {
			vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
				"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
			);
			vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
			const open = vi.spyOn(window, "open").mockReturnValue(null);
			vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-pdf");
			sidePane.openPreview({ kind: "pdf", title: "report.pdf", content: minimalPdfDataUrl(1) });
			const screen = render(PreviewPane, {});
			await vi.waitFor(
				() => expect(screen.baseElement.querySelectorAll('canvas[role="img"]').length).toBe(1),
				{ timeout: 30_000 }
			);
			// Not the old dead end.
			expect(screen.baseElement.textContent).not.toContain("opens in the browser's PDF viewer");
			await screen.getByRole("button", { name: /in a new tab/ }).click();
			await vi.waitFor(() => expect(open).toHaveBeenCalled());
			expect((open.mock.calls[0] as unknown as [string])[0]).toBe("blob:mock-pdf");
		}
	);

	it("closes the pane from its close button", async () => {
		sidePane.openPreview({ kind: "html", title: "index.html", content: "<h1>Hi</h1>" });
		const screen = render(PreviewPane, {});
		await tick();
		// Below desktop the backdrop carries the same name; the header's is last.
		const close = screen.getByRole("button", { name: "Close Preview" }).last();
		await expect.element(close).toBeVisible();
		await close.click();
		await tick();
		expect(sidePane.open).toBe(false);
		expect(screen.baseElement.querySelector("iframe")).toBeNull();
	});

	it("hides the ask-to-fix button without an onsend handler", async () => {
		sidePane.openPreview({ kind: "html", title: "index.html", content: "<h1>Hi</h1>" });
		const screen = render(PreviewPane, {});
		await tick();
		expect(screen.baseElement.textContent).not.toContain("ask to fix");
	});
});
