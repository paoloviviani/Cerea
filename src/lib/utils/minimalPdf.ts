/**
 * A valid one-or-more-page PDF built in memory (each page says its number),
 * for tests that need real bytes for pdf.js to draw.
 */
export function minimalPdf(pages = 1): Uint8Array {
	const objects: string[] = [];
	objects.push("<< /Type /Catalog /Pages 2 0 R >>");
	const kids = Array.from({ length: pages }, (_, i) => `${4 + i * 2} 0 R`).join(" ");
	objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`);
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	for (let i = 0; i < pages; i++) {
		const content = `BT /F1 36 Tf 40 140 Td (Page ${i + 1}) Tj ET`;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`
		);
		objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	}
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(out);
}

export function minimalPdfDataUrl(pages = 1): string {
	let binary = "";
	for (const byte of minimalPdf(pages)) binary += String.fromCharCode(byte);
	return `data:application/pdf;base64,${btoa(binary)}`;
}
