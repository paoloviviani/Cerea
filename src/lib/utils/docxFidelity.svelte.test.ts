import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { buildDocxSrcdoc } from "$lib/utils/previewSrcdoc";
import { renderDocxPreview, wantedStyles, fixSymbolGlyphs } from "$lib/utils/docxPreview";
import { mapSymbolText, symbolFontKind } from "$lib/utils/docxGlyphs";

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** A package with Symbol, Wingdings and Courier New bullets and Calibri/Cambria text. */
function buildDocx(): Uint8Array {
	const lvl = (n: number, text: string, font: string) =>
		`<w:abstractNum w:abstractNumId="${n}"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
		`<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr></w:lvl></w:abstractNum>`;
	const item = (id: number, t: string) =>
		`<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr></w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;
	return zipSync({
		"[Content_Types].xml": strToU8(
			`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
				`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
				`<Default Extension="xml" ContentType="application/xml"/>` +
				`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
				`<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
				`</Types>`
		),
		"_rels/.rels": strToU8(
			`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
				`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
		),
		"word/_rels/document.xml.rels": strToU8(
			`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
				`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`
		),
		"word/document.xml": strToU8(
			`${XML}<w:document xmlns:w="${W}"><w:body>` +
				`<w:p><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/></w:rPr><w:t>Calibri text</w:t></w:r></w:p>` +
				`<w:p><w:r><w:rPr><w:rFonts w:ascii="Cambria" w:hAnsi="Cambria"/><w:b/></w:rPr><w:t>Cambria bold</w:t></w:r></w:p>` +
				item(1, "Symbol item") +
				item(2, "Wingdings item") +
				item(3, "Courier item") +
				`<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>` +
				`</w:body></w:document>`
		),
		"word/numbering.xml": strToU8(
			`${XML}<w:numbering xmlns:w="${W}">` +
				lvl(1, "", "Symbol") +
				lvl(2, "", "Wingdings") +
				lvl(3, "o", "Courier New") +
				`<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>` +
				`<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>` +
				`<w:num w:numId="3"><w:abstractNumId w:val="3"/></w:num>` +
				`</w:numbering>`
		),
	});
}

describe("glyph table", () => {
	it("maps Symbol and Wingdings private-use characters, defaulting to a bullet", () => {
		expect(mapSymbolText("", "symbol").text).toBe("•");
		expect(mapSymbolText("", "wingdings").text).toBe("▪");
		expect(mapSymbolText("", "wingdings").text).toBe("➢");
		expect(mapSymbolText("", "wingdings").text).toBe("✓");
		expect(mapSymbolText("", "wingdings").text).toBe("•");
		expect(mapSymbolText("plain", "symbol")).toEqual({ text: "plain", changed: false });
		expect(mapSymbolText('content: "\\f0b7\\9"', "symbol", true).text).toBe('content: "•\\9"');
	});

	it("recognises the symbol fonts only", () => {
		expect(symbolFontKind('"Wingdings 2"')).toBe("wingdings");
		expect(symbolFontKind("Symbol")).toBe("symbol");
		expect(symbolFontKind("Courier New")).toBeNull();
	});

	it("rewrites inline runs and leaves letters in Symbol alone", () => {
		const root = document.createElement("div");
		root.innerHTML =
			'<span style="font-family: Wingdings"></span><span style="font-family: Symbol">a</span>';
		fixSymbolGlyphs(root);
		const [a, b] = root.querySelectorAll("span");
		expect(a.textContent).toBe("✓");
		expect(a.style.fontFamily).toBe("");
		expect(b.style.fontFamily).toBe("Symbol");
	});
});

describe("renderDocxPreview fidelity", () => {
	const fetched: string[] = [];
	const fetchFont = async (url: string) => {
		fetched.push(url);
		return new Uint8Array([0, 1, 2, 3]).buffer;
	};

	it(
		"turns Symbol/Wingdings bullets into Unicode and keeps Courier New's o",
		{ timeout: 20_000 },
		async () => {
			const html = await renderDocxPreview(buildDocx());
			expect(html).not.toMatch(/[-]/);
			expect(html).toContain("•");
			expect(html).toContain("▪");
			expect(html).not.toMatch(/font-family:\s*Symbol/i);
			expect(html).not.toMatch(/font-family:\s*Wingdings/i);
			expect(html).toMatch(/content:\s*"o/);
		}
	);

	it(
		"injects data: font faces only for the families and styles used",
		{ timeout: 20_000 },
		async () => {
			fetched.length = 0;
			const html = await renderDocxPreview(buildDocx(), { fontBase: "/fonts/office", fetchFont });
			expect(html).toContain('font-family:"Carlito"');
			expect(html).toContain('font-family:"Liberation Serif"');
			expect(html).toContain("src:url(data:font/ttf;base64,AAECAw==)");
			expect(html).toMatch(/font-family:\s*"?Carlito"?, Calibri/);
			expect(fetched).toContain("/fonts/office/Carlito-Regular.ttf");
			expect(fetched).toContain("/fonts/office/LiberationSerif-Bold.ttf");
			expect(fetched.some((u) => /Italic/.test(u))).toBe(false);
			expect(fetched.some((u) => /LiberationSans/.test(u))).toBe(false);
			expect(fetched).toContain("/fonts/office/LiberationMono-Regular.ttf");
		}
	);

	it(
		"falls back to the document's own fonts when a file cannot be fetched",
		{ timeout: 20_000 },
		async () => {
			const html = await renderDocxPreview(buildDocx(), {
				fontBase: "/nope",
				fetchFont: async () => {
					throw new Error("404");
				},
			});
			expect(html).not.toContain("@font-face");
			expect(html).toContain("Calibri text");
		}
	);

	it("chooses styles from what the HTML uses", () => {
		expect([...wantedStyles("<p>x</p>")]).toEqual(["Regular"]);
		expect([...wantedStyles('<span style="font-weight: bold;font-style: italic">')].sort()).toEqual(
			["Bold", "BoldItalic", "Italic", "Regular"]
		);
	});
});

function pageOf(frame: HTMLIFrameElement): { doc: Document; page: HTMLElement } {
	const doc = frame.contentDocument;
	const page = doc?.querySelector<HTMLElement>("section.docx");
	if (!doc || !page) throw new Error("the page did not render");
	return { doc, page };
}

describe("fit to the pane", () => {
	async function frameAt(width: number): Promise<HTMLIFrameElement> {
		const html = await renderDocxPreview(buildDocx());
		const frame = document.createElement("iframe");
		// allow-same-origin is for the test's own measuring; the product frame has no such token.
		frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
		frame.style.cssText = `width:${width}px;height:600px;border:0`;
		document.body.appendChild(frame);
		frame.srcdoc = buildDocxSrcdoc(html, "");
		await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		return frame;
	}

	it(
		"scales the page down to a narrow pane without a sideways scrollbar",
		{ timeout: 20_000 },
		async () => {
			const frame = await frameAt(360);
			const { doc, page: section } = pageOf(frame);
			expect(Number(section.style.zoom)).toBeLessThan(0.6);
			expect(doc.documentElement.scrollWidth).toBeLessThanOrEqual(doc.documentElement.clientWidth);
			frame.remove();
		}
	);

	it("never enlarges the page past its real size", { timeout: 20_000 }, async () => {
		const frame = await frameAt(1400);
		const { page: section } = pageOf(frame);
		expect(Number(section.style.zoom)).toBe(1);
		frame.remove();
	});

	it("refits when the pane is resized", { timeout: 20_000 }, async () => {
		const frame = await frameAt(1400);
		frame.style.width = "400px";
		await new Promise((resolve) => setTimeout(resolve, 300));
		const { doc, page } = pageOf(frame);
		expect(Number(page.style.zoom)).toBeLessThan(0.6);
		expect(doc.documentElement.scrollWidth).toBeLessThanOrEqual(doc.documentElement.clientWidth);
		frame.remove();
	});
});
