import { Readable } from "node:stream";
import { error } from "@sveltejs/kit";
import mimeTypes from "mime-types";
import { collections } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import type { MessageFile } from "$lib/types/Message";

/** The stored entry for this owner's file, 404 when there is none and 403 when it is not theirs. */
async function lookup(sha256: string, convId: Conversation["_id"] | string) {
	const file = await collections.blobStore.findOne("files", {
		filename: `${convId.toString()}-${sha256}`,
	});
	if (!file) {
		error(404, "File not found");
	}
	if (file.metadata?.conversation !== convId.toString()) {
		error(403, "You don't have access to this file.");
	}
	return file;
}

export async function downloadFile(
	sha256: string,
	convId: Conversation["_id"] | string
): Promise<MessageFile & { type: "base64" }> {
	const file = await lookup(sha256, convId);
	const mime = file.metadata.mime as string;
	const buffer = await collections.blobStore.read("files", file.id);

	return { type: "base64", name: file.filename, value: buffer.toString("base64"), mime };
}

/** One stored file as a stream, for responses: nothing is collected in memory. */
export interface StoredFileStream {
	stream: Readable;
	name: string;
	mime?: string;
	/** The whole file's size, always. */
	length: number;
	/** Set when only this slice (inclusive) was opened: the response is a 206. */
	range?: { start: number; end: number };
}

/**
 * One `Range: bytes=…` header against a file of `length` bytes: the slice to
 * serve, null for no (or an unusable) header, and a 416 for a range outside the
 * file. Only a single range is served; a list is answered as the whole file.
 */
export function parseRange(
	header: string | null | undefined,
	length: number
): { start: number; end: number } | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
	if (!match || (match[1] === "" && match[2] === "")) return null;
	let start: number;
	let end: number;
	if (match[1] === "") {
		// The last N bytes.
		const suffix = Number(match[2]);
		if (suffix === 0) error(416, "Range not satisfiable");
		start = Math.max(0, length - suffix);
		end = length - 1;
	} else {
		start = Number(match[1]);
		end = match[2] === "" ? length - 1 : Math.min(Number(match[2]), length - 1);
	}
	if (start >= length || start > end) error(416, "Range not satisfiable");
	return { start, end };
}

/** The same lookup and access checks as `downloadFile`, answering with a stream. */
export async function openFile(
	sha256: string,
	convId: Conversation["_id"] | string,
	rangeHeader?: string | null
): Promise<StoredFileStream> {
	const file = await lookup(sha256, convId);
	const range = parseRange(rangeHeader, file.length);
	return {
		stream: await collections.blobStore.open("files", file.id, range ? { range } : undefined),
		name: file.filename,
		mime: file.metadata.mime as string | undefined,
		length: file.length,
		...(range ? { range } : {}),
	};
}

/**
 * The stored size in bytes of each of a conversation's files, by hash — the
 * stored `length`, read without downloading anything. A hash with no stored
 * file is simply absent. Used to tell the model only what the browser will
 * really mount (`mountNamesByHash`).
 */
export async function storedSizes(
	hashes: readonly string[],
	convId: Conversation["_id"] | string
): Promise<Map<string, number>> {
	const sizes = new Map<string, number>();
	if (hashes.length === 0) return sizes;
	const prefix = `${convId.toString()}-`;
	const stored = await collections.blobStore.find("files", {
		filename: { $in: hashes.map((hash) => `${prefix}${hash}`) },
		"metadata.conversation": convId.toString(),
	});
	for (const file of stored) sizes.set(file.filename.slice(prefix.length), file.length);
	return sizes;
}

/**
 * "Download, never render": the response every stored-attachment route
 * answers with. An `<img>` still displays it (it ignores the disposition);
 * navigating to it saves a file instead of running whatever the bytes are,
 * the sandbox CSP holds even if a browser renders it anyway, and nosniff
 * stops a renderer from second-guessing a model-written Content-Type.
 */
export function attachmentResponse(
	sha256: string,
	file: { value: string; mime?: string }
): Response {
	const b64Value = Buffer.from(file.value, "base64");
	return new Response(b64Value, { headers: attachmentHeaders(sha256, file.mime, b64Value.length) });
}

/** `attachmentResponse`, for a stream: same headers, the body is never held whole. */
export function attachmentStreamResponse(sha256: string, file: StoredFileStream): Response {
	const headers: Record<string, string> = attachmentHeaders(
		sha256,
		file.mime,
		file.range ? file.range.end - file.range.start + 1 : file.length
	);
	if (file.range) {
		headers["Content-Range"] = `bytes ${file.range.start}-${file.range.end}/${file.length}`;
	}
	return new Response(Readable.toWeb(file.stream) as ReadableStream, {
		status: file.range ? 206 : 200,
		headers,
	});
}

function attachmentHeaders(sha256: string, mime: string | undefined, length: number) {
	return {
		"Content-Type": mime ?? "application/octet-stream",
		"Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'none'; sandbox;",
		"X-Content-Type-Options": "nosniff",
		"Content-Disposition": `attachment; filename="${sha256.slice(0, 8)}.${
			mime ? mimeTypes.extension(mime) || "bin" : "bin"
		}"`,
		"Content-Length": length.toString(),
		"Accept-Ranges": "bytes",
	};
}
