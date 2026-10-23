/**
 * Seeding for the produced-file specs: bytes into the output store (GridFS
 * `codeOutputs` + `codeExecutionOutputs`, as the upload route writes them),
 * and the update shapes a stored `execute_code` turn carries.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { GridFSBucket, ObjectId, type Db } from "mongodb";
import { minimalPdf } from "../src/lib/utils/minimalPdf.ts";

export const HELLO_PPTX = new URL("../src/lib/server/office/fixtures/hello.pptx", import.meta.url);

export function helloPptx(): Buffer {
	return readFileSync(HELLO_PPTX);
}

export function pdfBytes(pages = 2): Buffer {
	return Buffer.from(minimalPdf(pages));
}

function crc32(buf: Buffer): number {
	let crc = 0xffffffff;
	for (const b of buf) {
		crc ^= b;
		for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** A gradient PNG, for inline previews. */
export function pngBytes(w: number, h: number): Buffer {
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const stride = w * 3 + 1;
	const raw = Buffer.alloc(stride * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const o = y * stride + 1 + x * 3;
			raw[o] = (x * 255) / w;
			raw[o + 1] = (y * 255) / h;
			raw[o + 2] = 160;
		}
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

export interface SeededFile {
	name: string;
	size: number;
	sha256: string;
	uploaded?: boolean;
}

/** Store bytes for a conversation and return the reference a turn would record. */
export async function seedStoredFile(
	db: Db,
	conversationId: ObjectId,
	name: string,
	bytes: Buffer = randomBytes(2000)
): Promise<SeededFile> {
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const bucket = new GridFSBucket(db, { bucketName: "codeOutputs" });
	const gridFsId = new ObjectId();
	await new Promise<void>((resolve, reject) => {
		const stream = bucket.openUploadStreamWithId(gridFsId, `${conversationId}-${sha256}`);
		stream.once("finish", () => resolve());
		stream.once("error", reject);
		stream.end(bytes);
	});
	await db.collection("codeExecutionOutputs").insertOne({
		_id: new ObjectId(),
		conversationId,
		sha256,
		name,
		mime: "application/octet-stream",
		size: bytes.byteLength,
		gridFsId,
		createdAt: new Date(),
	} as never);
	return { name, size: bytes.byteLength, sha256 };
}

/** A reference for bytes that were produced but never stored. */
export function unsavedRef(name: string, size = 123): SeededFile {
	return {
		name,
		size,
		sha256: createHash("sha256").update(`never stored ${name}`).digest("hex"),
		uploaded: false,
	};
}

export const RUN_CODE =
	"from pptx import Presentation\nprs = Presentation()\nprs.save('deck.pptx')\n";

/** The updates of one stored `execute_code` turn, as the server writes them. */
export function codeRunUpdates(
	id: string,
	options: { files?: SeededFile[]; ok?: boolean; error?: string; code?: string }
): unknown[] {
	const code = options.code ?? RUN_CODE;
	const ok = options.ok ?? true;
	return [
		{
			type: "tool",
			subtype: "call",
			uuid: `tool-${id}`,
			call: { name: "execute_code", parameters: { code } },
		},
		{ type: "codeExecution", subtype: "request", executionId: id, code, toolUuid: `tool-${id}` },
		{
			type: "tool",
			subtype: "result",
			uuid: `tool-${id}`,
			result: {
				status: "success",
				call: { name: "execute_code", parameters: { code } },
				outputs: [{ text: "ok" }],
			},
		},
		{
			type: "codeExecution",
			subtype: "resolved",
			executionId: id,
			outcome: {
				ok,
				stdout: ok ? "Saved deck.pptx" : "",
				stderr: "",
				...(ok ? {} : { error: options.error ?? "ValueError: boom" }),
			},
			...(options.files ? { files: options.files } : {}),
		},
	];
}

export function finalAnswer(text: string): unknown {
	return { type: "finalAnswer", text, interrupted: false };
}

/** Write updates onto the n-th message of a seeded conversation. */
export async function setUpdates(
	db: Db,
	conversationId: ObjectId,
	index: number,
	updates: unknown[]
): Promise<void> {
	await db
		.collection("conversations")
		.updateOne({ _id: conversationId }, { $set: { [`messages.${index}.updates`]: updates } });
}
