import PreviewPane from "./PreviewPane.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, beforeEach } from "vitest";
import { tick } from "svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";

beforeEach(() => {
	sidePane.reset();
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
