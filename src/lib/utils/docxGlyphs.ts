/**
 * Word draws bullets and symbols with the Symbol and Wingdings fonts: the
 * numbering definition or run carries a private-use character (U+F020–U+F0FF,
 * the font's 0x20–0xFF shifted into the PUA block) plus a font name. A browser
 * has neither font, so the character renders as a missing-glyph box. The
 * preview swaps each such character for its Unicode equivalent and drops the
 * font, so the glyph comes from whatever normal font has it.
 */

/** Used for any private-use character not listed below: a plain bullet. */
export const DEFAULT_BULLET = "•";

/** Symbol (0xF0xx) -> Unicode. */
const SYMBOL_GLYPHS: Readonly<Record<number, string>> = {
	0xf0b7: "•", // bullet
	0xf0a7: "♣", // club
	0xf0a8: "♦", // diamond
	0xf0ae: "→", // right arrow
	0xf0de: "⇒", // right double arrow
	0xf0d7: "⋅", // dot operator
	0xf0b0: "°", // degree
};

/** Wingdings, Wingdings 2/3 and Webdings (0xF0xx) -> the closest Unicode symbol. */
const WINGDINGS_GLYPHS: Readonly<Record<number, string>> = {
	0xf0a7: "▪", // small black square
	0xf0d8: "➢", // arrowhead
	0xf0fc: "✓", // check mark
	0xf0fb: "✗", // ballot x
	0xf076: "❖", // black diamond minus white x
	0xf06e: "■", // black square
	0xf071: "❑", // shadowed white square
	0xf0a8: "◻", // white medium square
	0xf0e8: "➔", // heavy arrow
	0xf09f: "•", // bullet
	0xf06c: "●", // black circle
	0xf06f: "□", // white square
	0xf0a1: "○", // white circle
	0xf0b7: "•", // bullet
};

/** Which table a font name selects, or null when the font is not a symbol font. */
export function symbolFontKind(fontName: string): "symbol" | "wingdings" | null {
	const name = fontName.trim().replace(/^["']|["']$/g, "");
	if (/^symbol$/i.test(name)) return "symbol";
	if (/^(wingdings(\s*[23])?|webdings)$/i.test(name)) return "wingdings";
	return null;
}

export function isPrivateUseSymbol(code: number): boolean {
	return code >= 0xf020 && code <= 0xf0ff;
}

/** The Unicode glyph for a private-use symbol character of the given font. */
export function mapSymbolGlyph(code: number, kind: "symbol" | "wingdings"): string {
	const table = kind === "symbol" ? SYMBOL_GLYPHS : WINGDINGS_GLYPHS;
	return table[code] ?? DEFAULT_BULLET;
}

/**
 * Replace the private-use characters in `text` — written literally, or as CSS
 * escapes (`\f0b7`) when `cssEscapes` is set. Returns the text unchanged when
 * it has none; `changed` says whether it had any.
 */
export function mapSymbolText(
	text: string,
	kind: "symbol" | "wingdings",
	cssEscapes = false
): { text: string; changed: boolean } {
	let changed = false;
	let out = text.replace(/[-]/g, (ch) => {
		changed = true;
		return mapSymbolGlyph(ch.charCodeAt(0), kind);
	});
	if (cssEscapes) {
		// A CSS escape swallows one trailing space, so the replacement keeps none.
		out = out.replace(/\\(f0[0-9a-f]{2})(?:[ \t]?)/gi, (_m, hex: string) => {
			changed = true;
			return mapSymbolGlyph(parseInt(hex, 16), kind);
		});
	}
	return { text: out, changed };
}
