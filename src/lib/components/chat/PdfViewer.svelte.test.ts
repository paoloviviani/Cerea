import PdfViewer from "./PdfViewer.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect } from "vitest";
import { minimalPdf } from "$lib/utils/minimalPdf";

describe("PdfViewer download", () => {
	it("labels the rendered-PDF download with its format when the PDF is a conversion", async () => {
		const screen = render(PdfViewer, { title: "report", bytes: minimalPdf(1), showDownload: true });
		const btn = screen.baseElement.querySelector('[data-testid="pdf-download"]');
		expect(btn).not.toBeNull();
		expect(btn?.textContent).toContain("PDF");
		expect(btn?.getAttribute("title")).toBe("Download as PDF");
		expect(btn?.getAttribute("aria-label")).toBe("Download report as PDF");
	});

	it("offers its download by default (a PDF preview has no other)", async () => {
		const screen = render(PdfViewer, { title: "report", bytes: minimalPdf(1) });
		expect(screen.baseElement.querySelector('[data-testid="pdf-download"]')).not.toBeNull();
	});

	it("drops its download when told the header already has one", async () => {
		const screen = render(PdfViewer, {
			title: "report",
			bytes: minimalPdf(1),
			showDownload: false,
		});
		expect(screen.baseElement.querySelector('[data-testid="pdf-download"]')).toBeNull();
	});
});
