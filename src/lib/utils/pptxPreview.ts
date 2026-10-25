import { m } from "$lib/paraglide/messages";
/**
 * PowerPoint previews in the browser, for deployments without a converter
 * (the deploy kit's `office` profile off): pptx-glimpse draws each slide as an
 * SVG with the text turned into outlines.
 *
 * The SVG comes out of a user's file, so it is never put in the page as
 * markup. Each slide becomes a `data:image/svg+xml` URL for an `<img>`, where
 * a browser runs no script and loads nothing from the network, and the slides
 * are not reachable from the page's DOM.
 *
 * pptx-glimpse measures and outlines text with font files it is handed (a
 * browser has no way to scan fonts), so the fonts a deck uses are fetched
 * first — metric-compatible, openly licensed ones, mapped from the Office
 * names: Carlito for Calibri, Liberation Sans/Serif/Mono for Arial, Times New
 * Roman and Courier New. They are served from `static/fonts/office/`, fetched
 * only for the families the deck names, and the library itself is imported
 * only here, so none of it weighs on a conversation without a deck.
 */

import type { FontBuffer } from "pptx-glimpse";
import {
	FONT_STYLES,
	PREVIEW_FONT_FAMILIES,
	PREVIEW_FONT_MAPPING,
	type PreviewFamily,
	familyFor,
} from "./officeFonts";

export { PREVIEW_FONT_FAMILIES, PREVIEW_FONT_MAPPING };

/** A deck bigger than this is not parsed in the browser. */
export const PPTX_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** Slides drawn per deck; the rest is a note, not a freeze. */
export const PPTX_PREVIEW_MAX_SLIDES = 60;

export interface PreviewSlide {
	number: number;
	/** A `data:image/svg+xml` URL, for an `<img>` and nothing else. */
	src: string;
}

export interface PptxPreview {
	slides: PreviewSlide[];
	/**
	 * Set when the rendering is not faithful: what the library reported as
	 * unsupported, or the cut-off at the slide limit. A short sentence for a
	 * small note, with the details in `details`.
	 */
	note: string | null;
	details: string[];
}

export interface RenderOptions {
	/** Where the font files are served from. */
	fontBase: string;
	/** Fetches one font file; replaceable in tests. */
	fetchFont?: (url: string) => Promise<ArrayBuffer>;
}

async function defaultFetchFont(url: string): Promise<ArrayBuffer> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`font ${url}: ${res.status}`);
	return res.arrayBuffer();
}

function toDataUrl(svg: string): string {
	const bytes = new TextEncoder().encode(svg);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * Draw a deck. Throws when the file is not a PowerPoint the library can open;
 * the caller shows that as "the preview is unavailable".
 */
export async function renderPptxPreview(
	bytes: Uint8Array,
	options: RenderOptions
): Promise<PptxPreview> {
	if (bytes.byteLength > PPTX_PREVIEW_MAX_BYTES) {
		throw new Error("too large to preview — download it to read the whole deck");
	}
	// Dynamic import: neither the library nor its wasm-free parser may enter the
	// bundle of a conversation without a deck.
	const glimpse = await import("pptx-glimpse");
	const fetchFont = options.fetchFont ?? defaultFetchFont;

	// Which of our families the deck needs: those its fonts map to, and Carlito
	// always (Office's default, and what an unnamed font falls back to).
	const used = glimpse.collectUsedFonts(bytes);
	const names = new Set<string>(
		[...(used.fonts ?? []), used.theme?.majorFont, used.theme?.minorFont].filter(
			(n): n is string => typeof n === "string" && n.length > 0
		)
	);
	const mapping: Record<string, string> = {};
	const families = new Set<PreviewFamily>(["Carlito"]);
	for (const name of names) {
		const family = familyFor(name);
		mapping[name] = family ?? "Carlito";
		families.add(family ?? "Carlito");
	}

	const fonts = (
		await Promise.all(
			[...families].flatMap((family) =>
				FONT_STYLES.map(async (style): Promise<FontBuffer | null> => {
					try {
						const data = await fetchFont(
							`${options.fontBase}/${PREVIEW_FONT_FAMILIES[family]}-${style}.ttf`
						);
						return { name: family, data: new Uint8Array(data) };
					} catch {
						// One missing style is a plainer rendering, not a failed preview.
						return null;
					}
				})
			)
		)
	).filter((font): font is FontBuffer => font !== null);

	const report = await glimpse.convertPptxToSvg(bytes, {
		slides: Array.from({ length: PPTX_PREVIEW_MAX_SLIDES }, (_, i) => i + 1),
		fonts,
		fontMapping: mapping,
		textOutput: "path",
		logLevel: "off",
	});

	const slides: PreviewSlide[] = [];
	let refused = 0;
	for (const slide of report.slides) {
		// A script in the SVG would not run inside an <img>; a slide that has
		// one is not a slide, so it is left out rather than shown.
		if (/<script[\s>]/i.test(slide.svg)) {
			refused += 1;
			continue;
		}
		slides.push({ number: slide.slideNumber, src: toDataUrl(slide.svg) });
	}
	if (slides.length === 0) throw new Error(m["chat.errors.no_slides"]());

	const details = [
		...new Set(
			report.diagnostics
				.filter((d) => d.severity === "warning" || d.severity === "error")
				.map((d) => d.message)
		),
	];
	if (refused > 0) details.push(m["chat.errors.slides_left_out"]({ count: refused }));
	const cut = report.slides.length >= PPTX_PREVIEW_MAX_SLIDES;
	if (cut) details.push(m["chat.errors.slides_cut"]({ count: PPTX_PREVIEW_MAX_SLIDES }));

	return {
		slides,
		details,
		note: details.length > 0 ? m["chat.errors.approximate"]() : null,
	};
}
