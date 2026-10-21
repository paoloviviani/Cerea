/**
 * The open fonts the in-browser Office previews (pptx, docx) draw with, shared
 * so both map Office font names the same way. Files live in static/fonts/office/.
 */

/** The file families the preview can draw with: the name the library maps a font to, and its files. */
export const PREVIEW_FONT_FAMILIES = {
	Carlito: "Carlito",
	"Liberation Sans": "LiberationSans",
	"Liberation Serif": "LiberationSerif",
	"Liberation Mono": "LiberationMono",
} as const;

export const FONT_STYLES = ["Regular", "Bold", "Italic", "BoldItalic"] as const;

export type PreviewFamily = keyof typeof PREVIEW_FONT_FAMILIES;

/**
 * Office font name -> the open font that stands in for it. Replaces
 * pptx-glimpse's own table, whose Arimo/Tinos/Cousine are not what this app
 * ships (Liberation has the same metrics and is what the converter uses too).
 */
export const PREVIEW_FONT_MAPPING: Readonly<Record<string, PreviewFamily>> = {
	Calibri: "Carlito",
	"Calibri Light": "Carlito",
	Aptos: "Carlito",
	"Aptos Display": "Carlito",
	Arial: "Liberation Sans",
	Helvetica: "Liberation Sans",
	"Arial Narrow": "Liberation Sans",
	Verdana: "Liberation Sans",
	Tahoma: "Liberation Sans",
	"Segoe UI": "Liberation Sans",
	"Times New Roman": "Liberation Serif",
	Times: "Liberation Serif",
	Cambria: "Liberation Serif",
	Georgia: "Liberation Serif",
	"Courier New": "Liberation Mono",
	Consolas: "Liberation Mono",
};

export function familyFor(name: string | null | undefined): PreviewFamily | null {
	if (!name) return null;
	const wanted = name.trim().toLowerCase();
	for (const [office, family] of Object.entries(PREVIEW_FONT_MAPPING)) {
		if (office.toLowerCase() === wanted) return family;
	}
	for (const family of Object.keys(PREVIEW_FONT_FAMILIES) as PreviewFamily[]) {
		if (family.toLowerCase() === wanted) return family;
	}
	return null;
}
