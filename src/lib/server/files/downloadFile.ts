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
	length: number;
}

/** The same lookup and access checks as `downloadFile`, answering with a stream. */
export async function openFile(
	sha256: string,
	convId: Conversation["_id"] | string
): Promise<StoredFileStream> {
	const file = await lookup(sha256, convId);
	return {
		stream: await collections.blobStore.open("files", file.id),
		name: file.filename,
		mime: file.metadata.mime as string | undefined,
		length: file.length,
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
	return new Response(Readable.toWeb(file.stream) as ReadableStream, {
		headers: attachmentHeaders(sha256, file.mime, file.length),
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
		"Accept-Range": "bytes",
	};
}
