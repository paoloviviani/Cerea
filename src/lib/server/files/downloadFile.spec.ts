import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { ready } from "$lib/server/database";
import {
	attachmentResponse,
	attachmentStreamResponse,
	downloadFile,
	openFile,
	storedSizes,
} from "./downloadFile";
import { putBlob, removeBlobs } from "$lib/server/blobs/testing";

/**
 * The download response's hardening headers: `conversation/[id]/output/[sha256]`
 * (message attachments) and the `/code` attachment routes share this one
 * constructor, so the assertions live here rather than per route. The
 * code-execution deliverable route builds the same shape inline (see its
 * +server.ts) — kept in step by hand, asserted by reading, since spinning
 * that route needs a conversation row.
 */
describe("attachmentResponse", () => {
	it("downloads, never renders, with the sandbox CSP and nosniff", () => {
		const sha = "a".repeat(64);
		const res = attachmentResponse(sha, {
			value: Buffer.from("hello").toString("base64"),
			mime: "image/png",
		});
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("content-disposition")).toMatch(
			/^attachment; filename="aaaaaaaa\.png"$/
		);
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-length")).toBe("5");
	});

	it("falls back to an opaque type for untyped bytes", () => {
		const res = attachmentResponse("b".repeat(64), {
			value: Buffer.from("hello").toString("base64"),
		});
		expect(res.headers.get("content-type")).toBe("application/octet-stream");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
	});
});

describe("storedSizes", () => {
	const convId = new ObjectId();
	const other = new ObjectId();

	async function put(conv: ObjectId, hash: string, bytes: Buffer) {
		await putBlob(
			`${conv.toString()}-${hash}`,
			{ conversation: conv.toString(), mime: "text/plain" },
			bytes
		);
	}

	beforeAll(async () => {
		await ready;
		await put(convId, "h1", Buffer.alloc(1234));
		await put(other, "h2", Buffer.alloc(9));
	});

	afterAll(async () => {
		for (const id of [convId, other]) {
			await removeBlobs({ "metadata.conversation": id.toString() });
		}
	});

	it("reads the stored length without downloading, for this conversation's files only", async () => {
		const sizes = await storedSizes(["h1", "h2", "missing"], convId);
		expect([...sizes]).toEqual([["h1", 1234]]);
	});

	it("answers an empty list without a query", async () => {
		expect((await storedSizes([], convId)).size).toBe(0);
	});
});

describe("openFile", () => {
	const conv = new ObjectId();
	const sha = "c".repeat(64);
	const bytes = Buffer.from("streamed, not collected");

	beforeAll(async () => {
		await ready;
		await putBlob(
			`${conv.toString()}-${sha}`,
			{ conversation: conv.toString(), mime: "text/plain" },
			bytes
		);
	});

	afterAll(async () => {
		await removeBlobs({ "metadata.conversation": conv.toString() });
	});

	it("answers the same bytes and headers as the buffered path, from a stream", async () => {
		const streamed = attachmentStreamResponse(sha, await openFile(sha, conv));
		const buffered = attachmentResponse(sha, await downloadFile(sha, conv));
		expect(Buffer.from(await streamed.arrayBuffer())).toEqual(bytes);
		for (const header of [
			"content-type",
			"content-disposition",
			"content-security-policy",
			"x-content-type-options",
			"content-length",
		]) {
			expect(streamed.headers.get(header)).toBe(buffered.headers.get(header));
		}
	});

	it("advertises byte ranges", async () => {
		const res = attachmentStreamResponse(sha, await openFile(sha, conv));
		expect(res.status).toBe(200);
		expect(res.headers.get("accept-ranges")).toBe("bytes");
	});

	it("answers a Range with a 206, the slice and its Content-Range", async () => {
		const res = attachmentStreamResponse(sha, await openFile(sha, conv, "bytes=2-6"));
		expect(res.status).toBe(206);
		expect(res.headers.get("content-range")).toBe(`bytes 2-6/${bytes.length}`);
		expect(res.headers.get("content-length")).toBe("5");
		expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes.subarray(2, 7));
	});

	it("serves an open-ended and a suffix range, and clamps the end", async () => {
		const open = attachmentStreamResponse(sha, await openFile(sha, conv, "bytes=10-"));
		expect(Buffer.from(await open.arrayBuffer())).toEqual(bytes.subarray(10));
		const suffix = attachmentStreamResponse(sha, await openFile(sha, conv, "bytes=-4"));
		expect(Buffer.from(await suffix.arrayBuffer())).toEqual(bytes.subarray(bytes.length - 4));
		const clamped = attachmentStreamResponse(sha, await openFile(sha, conv, "bytes=0-9999"));
		expect(clamped.status).toBe(206);
		expect(Buffer.from(await clamped.arrayBuffer())).toEqual(bytes);
	});

	it("refuses a range outside the file with 416, and ignores a header it cannot read", async () => {
		await expect(openFile(sha, conv, `bytes=${bytes.length + 5}-`)).rejects.toMatchObject({
			status: 416,
		});
		const whole = attachmentStreamResponse(sha, await openFile(sha, conv, "items=1-2"));
		expect(whole.status).toBe(200);
	});

	it("keeps the same refusals: 404 for a missing file", async () => {
		await expect(openFile("d".repeat(64), conv)).rejects.toMatchObject({ status: 404 });
	});
});
