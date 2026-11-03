import { crc32, deflateSync } from "node:zlib";
import { zipSync, strToU8 } from "fflate";

/** Test fixtures: small but real files, so the file-type sniffing sees what a connector would send. */

/** A small xlsx: a zip with the parts that tell Excel from a plain zip. */
export function tinyXlsx(): Buffer {
	const rows = Array.from(
		{ length: 60 },
		(_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`
	);
	return Buffer.from(
		zipSync({
			"[Content_Types].xml": strToU8(
				'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>'
			),
			"_rels/.rels": strToU8("<Relationships/>"),
			"xl/workbook.xml": strToU8("<workbook/>"),
			"xl/worksheets/sheet1.xml": strToU8(
				`<worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`
			),
		})
	);
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/** A valid grayscale PNG of `side` x `side` pixels, over 1 KB for the default (noise does not compress). */
export function realPng(side = 48): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(side, 0);
	header.writeUInt32BE(side, 4);
	header[8] = 8; // bit depth
	header[9] = 0; // grayscale
	const raw = Buffer.alloc(side * (side + 1));
	let seed = 12345;
	for (let i = 0; i < raw.length; i += 1) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		raw[i] = i % (side + 1) === 0 ? 0 : seed >> 16;
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** A PDF-looking file: the signature and padding. */
export function pdfBytes(): Buffer {
	return Buffer.concat([
		Buffer.from("%PDF-1.7\n"),
		Buffer.alloc(1200, 0x20),
		Buffer.from("\n%%EOF"),
	]);
}
