import PreviewPane from "./PreviewPane.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tick } from "svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { __resetPdfInFrameCacheForTests } from "$lib/utils/previewSrcdoc";

beforeEach(() => {
	sidePane.reset();
	__resetPdfInFrameCacheForTests();
});

afterEach(() => {
	__resetPdfInFrameCacheForTests();
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

	it("frames a pdf payload by URL instead of building a srcdoc", async () => {
		sidePane.openPreview({
			kind: "pdf",
			title: "report.pdf",
			content: "data:application/pdf;base64,AAA",
		});
		const screen = render(PreviewPane, {});
		await tick();
		const iframe = screen.baseElement.querySelector('iframe[title="Preview of report.pdf"]');
		expect(iframe?.getAttribute("src")).toBe("data:application/pdf;base64,AAA");
		expect(iframe?.hasAttribute("srcdoc")).toBe(false);
		// The sandbox token set is deliberately ABSENT for a pdf: native
		// viewers refuse to attach to a sandboxed opaque-origin frame —
		// that refusal was Chrome's "blocked" panel and Safari's white box
		// on every desktop. A regression to sandbox={PREVIEW_SANDBOX} here
		// would blank the preview again, so pin the absence.
		expect(iframe?.hasAttribute("sandbox")).toBe(false);
	});

	it("gives a mobile browser a working pop-out instead of the dead iframe placeholder", async () => {
		// Mobile engines draw no PDF in an iframe; Chrome Android's placeholder
		// "Open" is dead under the preview sandbox. The pane must offer the
		// working version of that button: a new tab on the payload.
		const uaGetter = vi
			.spyOn(navigator, "userAgent", "get")
			.mockReturnValue(
				"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
			);
		const maxTouch = vi
			.spyOn(navigator, "maxTouchPoints", "get")
			.mockReturnValue(5) as unknown as () => void;
		const open = vi.spyOn(window, "open").mockReturnValue(null);
		const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock-pdf");
		const fetch_ = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]).buffer));
		try {
			sidePane.openPreview({
				kind: "pdf",
				title: "report.pdf",
				content: "data:application/pdf;base64,AAA",
			});
			const screen = render(PreviewPane, {});
			await tick();
			// No iframe to hold the dead placeholder — the pop-out replaces it.
			expect(screen.baseElement.querySelector("iframe")).toBeNull();
			const button = await screen.getByRole("button", { name: "Open in a new tab" });
			await button.click();
			await vi.waitFor(() => expect(open).toHaveBeenCalled());
			// data: URL converted to a blob URL: Chrome refuses top-level
			// data: navigations, so the unconverted form would be as dead as
			// the placeholder it replaces.
			expect(fetch_).toHaveBeenCalledWith("data:application/pdf;base64,AAA");
			expect(createObjectURL).toHaveBeenCalled();
			const [url, target] = open.mock.calls[0] as unknown as [string, string];
			expect(url).toBe("blob:mock-pdf");
			expect(target).toBe("_blank");
		} finally {
			uaGetter.mockRestore();
			(maxTouch as unknown as { mockRestore: () => void }).mockRestore();
			open.mockRestore();
			createObjectURL.mockRestore();
			fetch_.mockRestore();
		}
	});

	it("closes the pane from its close button", async () => {
		sidePane.openPreview({ kind: "html", title: "index.html", content: "<h1>Hi</h1>" });
		const screen = render(PreviewPane, {});
		await tick();
		await expect.element(screen.getByRole("button", { name: "Close preview pane" })).toBeVisible();
		await screen.getByRole("button", { name: "Close preview pane" }).click();
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
