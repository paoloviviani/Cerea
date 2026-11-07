/**
 * The real KaTeX for slides: the library (with mhchem for `\ce{}`), its
 * stylesheet, and its woff2 fonts as `data:` URIs. A separate module, loaded
 * only for a deck that contains math, so the fonts (about 300 kB) never
 * reach a page that has none. See math.ts for what is done with them.
 */
import katex from "katex";
import "katex/dist/contrib/mhchem.mjs";
import katexCss from "katex/dist/katex.min.css?raw";
import { buildKatexCss, type KatexLike, type MathSupport } from "./math";

const fontModules = import.meta.glob("../../../../node_modules/katex/dist/fonts/*.woff2", {
	query: "?inline",
	import: "default",
	eager: true,
}) as Record<string, string>;

const FONTS: Record<string, string> = Object.fromEntries(
	Object.entries(fontModules).map(([path, data]) => [path.split("/").pop() ?? path, data])
);

export const math: MathSupport = {
	katex: katex as unknown as KatexLike,
	css: (renderedHtml) => buildKatexCss(katexCss, FONTS, renderedHtml),
};
