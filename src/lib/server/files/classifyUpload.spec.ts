import { describe, expect, it } from "vitest";
import { classifyUpload, isTextContent, sniffTextMime, TEXT_SNIFF_BYTES } from "./classifyUpload";

const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf-8"));

describe("isTextContent", () => {
	it("takes UTF-8, with or without a BOM", () => {
		expect(isTextContent(utf8("héllo wörld, 日本語"))).toBe(true);
		expect(isTextContent(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi")]))).toBe(
			true
		);
		expect(isTextContent(new Uint8Array())).toBe(true);
	});

	it("takes UTF-16 with a BOM, either order", () => {
		const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("hello", "utf16le")]);
		const be = Buffer.from(le);
		be.swap16();
		expect(isTextContent(le)).toBe(true);
		expect(isTextContent(be)).toBe(true);
	});

	it("refuses a NUL byte and invalid UTF-8", () => {
		expect(isTextContent(Buffer.from([0x68, 0x69, 0x00, 0x21]))).toBe(false);
		expect(isTextContent(Buffer.from([0x68, 0xff, 0xfe, 0x21]))).toBe(false);
		expect(isTextContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe(
			false
		);
	});

	it("reads only the head of a big file", () => {
		const big = new Uint8Array(TEXT_SNIFF_BYTES * 4).fill(0x61);
		// A NUL past the head is not looked for, and a multi-byte character cut by the head is fine.
		big[TEXT_SNIFF_BYTES + 10] = 0;
		expect(isTextContent(big)).toBe(true);
		const cut = new Uint8Array(TEXT_SNIFF_BYTES + 10).fill(0x61);
		cut.set([0xe2, 0x82, 0xac], TEXT_SNIFF_BYTES - 1); // the euro sign straddles the head
		expect(isTextContent(cut)).toBe(true);
		const early = new Uint8Array(TEXT_SNIFF_BYTES * 4).fill(0x61);
		early[100] = 0;
		expect(isTextContent(early)).toBe(false);
	});
});

describe("sniffTextMime", () => {
	it("names XML, JSON and HTML from the first characters, else text/plain", () => {
		expect(sniffTextMime(utf8('  <?xml version="1.0"?><a/>'))).toBe("application/xml");
		expect(sniffTextMime(utf8("<mxfile><diagram/></mxfile>"))).toBe("application/xml");
		expect(sniffTextMime(utf8('{"a":[1,2]}'))).toBe("application/json");
		expect(sniffTextMime(utf8('{"a":1}\n{"a":2}\n'))).toBe("text/plain");
		expect(sniffTextMime(utf8("[section]\nkey=1\n"))).toBe("text/plain");
		expect(sniffTextMime(utf8("<!DOCTYPE html><html></html>"))).toBe("text/html");
		expect(sniffTextMime(utf8("plain words"))).toBe("text/plain");
	});
});

describe("classifyUpload", () => {
	it("calls unknown-extension text text, and keeps a declared text type", async () => {
		expect((await classifyUpload("a.drawio", "", utf8("<mxfile/>"))).mime).toBe("application/xml");
		expect((await classifyUpload("a.foo", "application/octet-stream", utf8("x"))).kind).toBe(
			"text"
		);
		expect(await classifyUpload("a.csv", "text/csv", utf8("a,b\n1,2\n"))).toEqual({
			kind: "text",
			mime: "text/csv",
		});
		expect((await classifyUpload("n.md", "", utf8("# hi"))).mime).toBe("text/markdown");
	});

	it("takes a declared text type holding single-byte text, but not binary", async () => {
		const latin1 = Buffer.from("name;ville\nRené;Genève\n", "latin1");
		expect((await classifyUpload("a.csv", "text/csv", latin1)).kind).toBe("text");
		expect((await classifyUpload("a.foo", "", latin1)).kind).toBe("unsupported");
		expect((await classifyUpload("a.txt", "text/plain", Buffer.from([1, 0, 2]))).kind).toBe(
			"unsupported"
		);
	});

	it("refuses unknown binary and known non-document binary", async () => {
		expect(
			(await classifyUpload("a.bin", "application/octet-stream", Buffer.from([0, 1, 2, 3]))).kind
		).toBe("unsupported");
		const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
		expect(await classifyUpload("a.png", "image/png", png)).toEqual({
			kind: "image",
			mime: "image/png",
		});
	});

	it("re-encodes UTF-16 text as UTF-8", async () => {
		const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo", "utf16le")]);
		const result = await classifyUpload("a.foo", "", le);
		expect(result.kind).toBe("text");
		expect(result.kind === "text" && result.bytes?.toString("utf-8")).toBe("héllo");
	});
});

describe("classifyUpload: audio the browsers and phones name in their own ways", () => {
	const box = (type: string, payload: Buffer) => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(8 + payload.length, 0);
		head.write(type, 4, "latin1");
		return Buffer.concat([head, payload]);
	};
	const handler = (kind: "vide" | "soun") =>
		box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from(kind, "latin1"), Buffer.alloc(12)]));
	/** An MP4-family file: an `ftyp` of this brand, then one track per kind. */
	const mp4 = (brand: string, ...kinds: ("vide" | "soun")[]) =>
		Buffer.concat([
			box("ftyp", Buffer.concat([Buffer.from(brand, "latin1"), Buffer.alloc(4)])),
			...kinds.map(handler),
		]);
	/** The first Ogg page of an Opus stream: `OpusHead` is what `file-type` looks for. */
	const oggOpus = () =>
		Buffer.concat([
			Buffer.from("OggS"),
			Buffer.from([0, 2]),
			Buffer.alloc(20),
			Buffer.from([1, 19]),
			Buffer.from("OpusHead"),
			Buffer.from([1, 1, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]),
			Buffer.alloc(40),
		]);

	it("takes Opus in Ogg whatever the browser says or leaves empty", async () => {
		for (const declared of [
			"",
			"audio/ogg",
			"audio/opus",
			"audio/x-opus+ogg",
			"audio/ogg; codecs=opus",
		]) {
			expect(await classifyUpload("note.opus", declared, oggOpus())).toEqual({
				kind: "audio",
				mime: "audio/ogg",
			});
		}
	});

	it("takes an M4A, and the audio-only MP4 and 3GPP files phone recorders write", async () => {
		for (const brand of ["M4A ", "isom", "mp42", "3gp4", "3gp5", "3g2a", "qt  ", "M4V "]) {
			expect(await classifyUpload("rec.m4a", "", mp4(brand, "soun"))).toEqual({
				kind: "audio",
				mime: "audio/mp4",
			});
		}
	});

	it("does not take a 3GPP or MP4 file that has a picture", async () => {
		for (const brand of ["3gp4", "isom"]) {
			const result = await classifyUpload("clip.3gp", "video/3gpp", mp4(brand, "vide", "soun"));
			expect(result.kind).toBe("unsupported");
			expect((result as { message?: string }).message).toMatch(/video track/);
		}
	});

	it("says in words that raw AAC is not taken, and what is", async () => {
		const adts = Buffer.concat([
			Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x02, 0x1f, 0xfc]),
			Buffer.alloc(200),
		]);
		const result = await classifyUpload("memo.aac", "audio/aac", adts);
		expect(result.kind).toBe("unsupported");
		expect((result as { message?: string }).message).toMatch(/AAC.*M4A or MP3/);
	});
});
