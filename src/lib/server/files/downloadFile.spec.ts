import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { attachmentResponse, storedSizes } from "./downloadFile";

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
		const upload = collections.bucket.openUploadStream(`${conv.toString()}-${hash}`, {
			metadata: { conversation: conv.toString(), mime: "text/plain" },
		});
		await new Promise<void>((resolve, reject) => {
			upload.on("error", reject);
			upload.on("finish", () => resolve());
			upload.end(bytes);
		});
	}

	beforeAll(async () => {
		await ready;
		await put(convId, "h1", Buffer.alloc(1234));
		await put(other, "h2", Buffer.alloc(9));
	});

	afterAll(async () => {
		for (const id of [convId, other]) {
			for (const file of await collections.bucket
				.find({ "metadata.conversation": id.toString() })
				.toArray()) {
				await collections.bucket.delete(file._id);
			}
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
