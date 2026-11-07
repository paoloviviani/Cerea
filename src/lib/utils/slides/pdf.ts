/**
 * A minimal PDF writer for slide pages: one JPEG per page, nothing else.
 * Slides are drawn to pictures inside the preview sandbox (see
 * slidesPdf.ts), and a picture-per-page PDF needs no library.
 */

export interface PdfPage {
	/** Raw JPEG bytes */
	jpeg: Uint8Array;
	/** Pixel size of the picture */
	width: number;
	height: number;
}

const enc = new TextEncoder();

export function dataUrlToBytes(dataUrl: string): Uint8Array {
	const comma = dataUrl.indexOf(",");
	const bin = atob(dataUrl.slice(comma + 1));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Width and height from a JPEG's start-of-frame marker; undefined if not a JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
	let i = 2;
	while (i + 9 < bytes.length) {
		if (bytes[i] !== 0xff) {
			i++;
			continue;
		}
		const marker = bytes[i + 1];
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			i += 2;
			continue;
		}
		const len = (bytes[i + 2] << 8) | bytes[i + 3];
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return {
				height: (bytes[i + 5] << 8) | bytes[i + 6],
				width: (bytes[i + 7] << 8) | bytes[i + 8],
			};
		}
		i += 2 + len;
	}
	return undefined;
}

/** Build the PDF; a page is its picture at 0.75 pt per pixel (1280 px wide is 960 pt, 16:9 slides stay 16:9). */
export function buildPdf(pages: PdfPage[], title = "Slides"): Blob {
	const chunks: Uint8Array[] = [];
	const offsets: number[] = [];
	let length = 0;
	const push = (data: Uint8Array | string) => {
		const bytes = typeof data === "string" ? enc.encode(data) : data;
		chunks.push(bytes);
		length += bytes.length;
	};
	const object = (n: number, body: string | Uint8Array[]) => {
		offsets[n] = length;
		push(`${n} 0 obj\n`);
		if (typeof body === "string") push(body);
		else body.forEach(push);
		push("\nendobj\n");
	};

	// Objects: 1 catalog, 2 pages, 3 info, then per page: page, contents, image
	push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
	object(1, "<< /Type /Catalog /Pages 2 0 R >>");
	const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(" ");
	object(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
	const safeTitle = title.replace(/[^\x20-\x7e]/g, "?").replace(/[()\\]/g, "");
	object(3, `<< /Title (${safeTitle}) /Producer (Cerea) >>`);
	pages.forEach((page, i) => {
		const pageN = 4 + i * 3;
		const w = +(page.width * 0.75).toFixed(2);
		const h = +(page.height * 0.75).toFixed(2);
		object(
			pageN,
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${pageN + 2} 0 R >> >> /Contents ${pageN + 1} 0 R >>`
		);
		const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
		object(pageN + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
		object(pageN + 2, [
			enc.encode(
				`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`
			),
			page.jpeg,
			enc.encode("\nendstream"),
		]);
	});
	const count = 4 + pages.length * 3;
	const xref = length;
	let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
	for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
	push(table);
	push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
	return new Blob(chunks as BlobPart[], { type: "application/pdf" });
}
