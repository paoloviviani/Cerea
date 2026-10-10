import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { renderDocxPreview, sanitizeDocxHtml } from "$lib/utils/docxPreview";

/**
 * A minimal OOXML package built right here: one heading paragraph on a styled
 * pStyle (Heading1, with its own size and colour in styles.xml), a bold run, a
 * numbered-list paragraph (numPr into numbering.xml) and a bordered table.
 *
 * The real renderer runs, not a mock: the regression this pins lives in what
 * docx-preview and DOMPurify produce TOGETHER — docx-preview leads its output
 * with a <style> block, and the sanitize step used to drop exactly that block,
 * so a mocked renderer could never see the loss.
 */
function buildStyledDocx(): Uint8Array {
	const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
	const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
	return zipSync({
		"[Content_Types].xml": strToU8(
			`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
				`<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
				`<Default Extension="xml" ContentType="application/xml"/>` +
				`<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
				`<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
				`<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
				`</Types>`
		),
		"_rels/.rels": strToU8(
			`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
				`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
				`</Relationships>`
		),
		"word/_rels/document.xml.rels": strToU8(
			`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
				`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
				`<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
				`</Relationships>`
		),
		"word/document.xml": strToU8(
			`${XML}<w:document xmlns:w="${W}"><w:body>` +
				`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>` +
				`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold finding</w:t></w:r></w:p>` +
				`<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Listed item</w:t></w:r></w:p>` +
				`<w:tbl><w:tblPr><w:tblBorders>` +
				`<w:top w:val="single" w:sz="4" w:color="000000"/>` +
				`<w:left w:val="single" w:sz="4" w:color="000000"/>` +
				`<w:bottom w:val="single" w:sz="4" w:color="000000"/>` +
				`<w:right w:val="single" w:sz="4" w:color="000000"/>` +
				`</w:tblBorders></w:tblPr>` +
				`<w:tr><w:tc><w:p><w:r><w:t>Cell one</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell two</w:t></w:r></w:p></w:tc></w:tr>` +
				`</w:tbl>` +
				`</w:body></w:document>`
		),
		"word/styles.xml": strToU8(
			`${XML}<w:styles xmlns:w="${W}">` +
				`<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>` +
				`<w:pPr><w:outlineLvl w:val="0"/></w:pPr>` +
				`<w:rPr><w:b/><w:color w:val="2E74B5"/><w:sz w:val="32"/></w:rPr></w:style>` +
				`</w:styles>`
		),
		"word/numbering.xml": strToU8(
			`${XML}<w:numbering xmlns:w="${W}">` +
				`<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0">` +
				`<w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>` +
				`</w:lvl></w:abstractNum>` +
				`<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
				`</w:numbering>`
		),
	});
}

describe("renderDocxPreview", () => {
	it("keeps the document's formatting in the sanitized HTML", { timeout: 20_000 }, async () => {
		const html = await renderDocxPreview(buildStyledDocx());

		// The style block survives sanitization. It leads the container —
		// exactly the position DOMPurify's default parsing loses (a
		// fragment that begins with <style> parses into <head>), which is
		// how the preview used to render with no formatting at all.
		expect(html).toContain("<style");
		expect(html).toContain(".docx-wrapper");

		// The document's own styling reached the HTML: the Heading1 colour
		// from styles.xml shows up in the emitted CSS, not just the text.
		expect(html.toLowerCase()).toContain("2e74b5");

		// Heading, bold run, list item and table content are all present.
		expect(html).toContain("Quarterly Report");
		expect(html).toContain("Bold finding");
		expect(html).toContain("Listed item");
		expect(html).toContain("<table");
		expect(html).toContain("Cell one");
	});

	it("rejects bytes that are no Word document at all", async () => {
		// Not a zip: the renderer must fail loudly here, so the call sites'
		// error mapping shows the reason instead of an empty panel.
		await expect(renderDocxPreview(new Uint8Array([0]))).rejects.toThrow(/zip/i);
	});
});

describe("sanitizeDocxHtml", () => {
	it("keeps the style block but strips active content", () => {
		const html = sanitizeDocxHtml(
			'<style>p{color:red}</style><script>alert(1)</script><p onclick="evil()">t</p>'
		);
		expect(html).toContain("<style>p{color:red}</style>");
		expect(html).toContain("<p");
		expect(html).toContain("t</p>");
		expect(html).not.toContain("<script");
		expect(html).not.toContain("onclick");
	});
});
