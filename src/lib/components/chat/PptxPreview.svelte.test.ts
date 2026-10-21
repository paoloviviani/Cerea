import PreviewPane from "./PreviewPane.svelte";
import { render } from "vitest-browser-svelte";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { tick } from "svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { renderPptxPreview } from "$lib/utils/pptxPreview";
import { slidesPayloadFor } from "$lib/utils/officePreview";
// A deck written by python-pptx (src/lib/server/office/fixtures).
import deckUrl from "../../server/office/fixtures/hello.pptx?url";
const carlitoUrl = "/fonts/office/Carlito-Regular.ttf";

beforeEach(() => sidePane.reset());

async function deck(): Promise<Uint8Array> {
	return new Uint8Array(await (await fetch(deckUrl)).arrayBuffer());
}
const fetchFont = async () => (await fetch(carlitoUrl)).arrayBuffer();

describe("pptx-glimpse fallback", () => {
	it("draws each slide as an SVG data URL, fetching only the fonts the deck needs", async () => {
		const asked: string[] = [];
		const preview = await renderPptxPreview(await deck(), {
			fontBase: "/fonts/office",
			fetchFont: async (url) => {
				asked.push(url);
				return fetchFont();
			},
		});
		expect(preview.slides).toHaveLength(1);
		expect(preview.slides[0].src).toMatch(/^data:image\/svg\+xml;base64,/);
		const svg = atob(preview.slides[0].src.split(",")[1]);
		expect(svg.startsWith("<svg")).toBe(true);
		// Text as outlines: the words are paths, not <text> that needs fonts at view time.
		expect(svg).not.toContain("<text");
		// The deck is Calibri: Carlito's four styles, and no Liberation file.
		expect(asked).toEqual(
			["Regular", "Bold", "Italic", "BoldItalic"].map((s) => `/fonts/office/Carlito-${s}.ttf`)
		);
	});

	it("refuses a file that is not a deck, and one that is too large, with a sentence", async () => {
		await expect(
			renderPptxPreview(new TextEncoder().encode("not a zip"), { fontBase: "/f", fetchFont })
		).rejects.toThrow();
		await expect(
			renderPptxPreview(new Uint8Array(21 * 1024 * 1024), { fontBase: "/f", fetchFont })
		).rejects.toThrow(/too large/);
	});

	it("shows the slides as images in the pane, never as live SVG markup", async () => {
		const bytes = await deck();
		const payload = await slidesPayloadFor("Roadmap.pptx", bytes);
		expect(payload.kind).toBe("slides");
		sidePane.openPreview(payload);
		const screen = render(PreviewPane, {});
		await tick();
		const images = screen.baseElement.querySelectorAll('[data-testid="pptx-slides"] img');
		expect(images).toHaveLength(1);
		expect(images[0].getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/);
		expect(images[0].getAttribute("alt")).toBe("Roadmap.pptx, slide 1");
		// Nothing of the deck is in the page as markup: no svg element, no iframe.
		expect(screen.baseElement.querySelector("svg:not([class])")).toBeNull();
		expect(screen.baseElement.querySelector('[data-testid="pptx-slides"] svg')).toBeNull();
		expect(screen.baseElement.querySelector("iframe")).toBeNull();
	});

	it("says it is an approximate rendering when the library reports unsupported features", async () => {
		sidePane.openPreview({
			kind: "slides",
			title: "d.pptx",
			content: "",
			slides: [{ number: 1, src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }],
			note: "Approximate rendering: this deck uses features the browser preview does not draw. Download it for the real thing.",
			details: ["Chart not supported"],
		});
		const screen = render(PreviewPane, {});
		await tick();
		const note = screen.baseElement.querySelector('[data-testid="pptx-approximate"]');
		expect(note?.textContent).toContain("Approximate rendering");
		expect(note?.getAttribute("title")).toBe("Chart not supported");
	});

	it("does not draw an approximation note for a faithful deck", async () => {
		sidePane.openPreview({
			kind: "slides",
			title: "d.pptx",
			content: "",
			slides: [{ number: 1, src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }],
			note: null,
		});
		const screen = render(PreviewPane, {});
		await tick();
		expect(screen.baseElement.querySelector('[data-testid="pptx-approximate"]')).toBeNull();
	});
});

vi.mock("$app/paths", () => ({ base: "" }));
