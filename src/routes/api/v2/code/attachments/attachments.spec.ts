/**
 * The `/code` attachment routes against the real bucket and `codeDevices`:
 * upload and list by message, serving with chat's download-only headers, the
 * device-ownership check (another person's key is a 404, as a missing device
 * is), chat's limits, and the revoke path's cleanup.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import superjson from "superjson";
import { ObjectId } from "mongodb";

vi.mock("$lib/server/codeEnabled", () => ({ codeAgentsEnabled: () => true }));
// The revoke route drops the relay link; nothing here should dial one.
vi.mock("$lib/server/codeDaemon", () => ({ dropLink: vi.fn() }));

import { POST as upload, GET as list } from "./[key]/+server";
import { GET as serve } from "./[key]/[sha256]/+server";
import { DELETE as revoke } from "../devices/+server";
import { collections, ready } from "$lib/server/database";
import { deleteAttachmentsByPrefix } from "$lib/server/files/attachmentStore";
import { MAX_ATTACHMENT_BYTES } from "$lib/constants/mime";
import type { MessageFile } from "$lib/types/Message";

beforeAll(async () => {
	await ready;
});

const devices: ObjectId[] = [];

afterEach(async () => {
	for (const id of devices.splice(0)) {
		await deleteAttachmentsByPrefix(`code:${id.toHexString()}:`);
		await collections.codeDevices.deleteOne({ _id: id });
	}
});

const alice = { sessionId: `alice-${new ObjectId()}` } as App.Locals;
const bob = { sessionId: `bob-${new ObjectId()}` } as App.Locals;

async function pairedDevice(owner: App.Locals, status: "paired" | "pending" = "paired") {
	const _id = new ObjectId();
	devices.push(_id);
	await collections.codeDevices.insertOne({
		_id,
		sessionId: owner.sessionId,
		name: "box",
		status,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	return _id.toHexString();
}

type Event<T extends (...args: never[]) => unknown> = Parameters<T>[0];

function uploadEvent(locals: App.Locals, key: string, form: FormData) {
	const request = new Request(`http://localhost/api/v2/code/attachments/${key}`, {
		method: "POST",
		body: form,
	});
	return { locals, params: { key }, request, url: new URL(request.url) } as unknown as Event<
		typeof upload
	>;
}

function formWith(messageId: string | null, ...files: File[]) {
	const form = new FormData();
	if (messageId !== null) form.set("messageId", messageId);
	for (const file of files) form.append("files", file);
	return form;
}

const png = (name = "shot.png") =>
	new File([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")], name, { type: "image/png" });

async function status(promise: Response | Promise<Response>): Promise<number> {
	try {
		return (await promise).status;
	} catch (err) {
		return (err as { status?: number }).status ?? -1;
	}
}

async function uploadOk(locals: App.Locals, key: string, form: FormData): Promise<MessageFile[]> {
	const res = await upload(uploadEvent(locals, key, form));
	expect(res.status).toBe(200);
	return superjson.parse<{ files: MessageFile[] }>(await res.text()).files;
}

function listEvent(locals: App.Locals, key: string, messageId: string) {
	const url = new URL(`http://localhost/api/v2/code/attachments/${key}?messageId=${messageId}`);
	return { locals, params: { key }, url } as unknown as Event<typeof list>;
}

function serveEvent(locals: App.Locals, key: string, sha256: string) {
	return { locals, params: { key, sha256 } } as unknown as Event<typeof serve>;
}

describe("upload, list and serve", () => {
	it("stores what a message was sent with and serves it back, download-only", async () => {
		const device = await pairedDevice(alice);
		const key = `code:${device}:ses_1`;
		const files = await uploadOk(
			alice,
			key,
			formWith("msg-1", png(), new File(["hi"], "a.txt", { type: "text/plain" }))
		);
		expect(files.map((f) => f.name)).toEqual(["shot.png", "a.txt"]);

		const listed = await list(listEvent(alice, key, "msg-1"));
		expect(superjson.parse<{ files: MessageFile[] }>(await listed.text()).files).toEqual(files);

		const res = await serve(serveEvent(alice, key, files[0].value));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="/);
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(Buffer.from(await res.arrayBuffer())).toEqual(
			Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
		);
	});
});

describe("ownership", () => {
	it("refuses another person's key on every route, as if the device did not exist", async () => {
		const device = await pairedDevice(alice);
		const key = `code:${device}:ses_1`;
		const [file] = await uploadOk(alice, key, formWith("m", png()));

		expect(await status(upload(uploadEvent(bob, key, formWith("m", png()))))).toBe(404);
		expect(await status(list(listEvent(bob, key, "m")))).toBe(404);
		expect(await status(serve(serveEvent(bob, key, file.value)))).toBe(404);
		// Nothing was written under alice's key by bob's attempt.
		expect(await collections.bucketFiles.countDocuments({ "metadata.conversation": key })).toBe(1);
	});

	it("does not serve a file under a different session's key on the same device", async () => {
		const device = await pairedDevice(alice);
		const [file] = await uploadOk(alice, `code:${device}:ses_1`, formWith("m", png()));
		expect(await status(serve(serveEvent(alice, `code:${device}:ses_2`, file.value)))).toBe(404);
	});

	it("refuses keys that are not code keys, including a bare conversation id", async () => {
		for (const key of [new ObjectId().toHexString(), "code:nothex:ses", "other:abc:def"]) {
			expect(await status(upload(uploadEvent(alice, key, formWith("m", png()))))).toBe(400);
		}
	});

	it("refuses a device that is not paired", async () => {
		const device = await pairedDevice(alice, "pending");
		const key = `code:${device}:ses_1`;
		expect(await status(upload(uploadEvent(alice, key, formWith("m", png()))))).toBe(409);
	});

	it("requires a session", async () => {
		const device = await pairedDevice(alice);
		const key = `code:${device}:ses_1`;
		expect(await status(list(listEvent({} as App.Locals, key, "m")))).toBe(401);
	});
});

describe("limits", () => {
	it("applies chat's size limit with chat's status", async () => {
		const device = await pairedDevice(alice);
		const big = new File([Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)], "big.txt", {
			type: "text/plain",
		});
		expect(await status(upload(uploadEvent(alice, `code:${device}:s`, formWith("m", big))))).toBe(
			413
		);
	});

	it("refuses a type outside the allowlist, a missing message id, and an empty upload", async () => {
		const device = await pairedDevice(alice);
		const key = `code:${device}:s`;
		const exe = new File(["MZ"], "x.exe", { type: "application/x-msdownload" });
		expect(await status(upload(uploadEvent(alice, key, formWith("m", exe))))).toBe(400);
		expect(await status(upload(uploadEvent(alice, key, formWith(null, png()))))).toBe(400);
		expect(await status(upload(uploadEvent(alice, key, formWith("m"))))).toBe(400);
		expect(await collections.bucketFiles.countDocuments({ "metadata.conversation": key })).toBe(0);
	});
});

describe("revoke", () => {
	it("deletes every session's attachments on the revoked device, and only that device's", async () => {
		const device = await pairedDevice(alice);
		const other = await pairedDevice(alice);
		await uploadOk(alice, `code:${device}:ses_1`, formWith("m", png()));
		await uploadOk(alice, `code:${device}:ses_2`, formWith("m", png()));
		await uploadOk(alice, `code:${other}:ses_1`, formWith("m", png()));

		const url = new URL(`http://localhost/api/v2/code/devices?id=${device}`);
		const res = await revoke({ locals: alice, url } as unknown as Event<typeof revoke>);
		expect(res.status).toBe(200);

		const prefix = (id: string) => ({ "metadata.conversation": { $regex: `^code:${id}:` } });
		expect(await collections.bucketFiles.countDocuments(prefix(device))).toBe(0);
		expect(await collections.bucketFiles.countDocuments(prefix(other))).toBe(1);
	});

	it("does not delete anything when somebody else tries to revoke the device", async () => {
		const device = await pairedDevice(alice);
		await uploadOk(alice, `code:${device}:ses_1`, formWith("m", png()));
		const url = new URL(`http://localhost/api/v2/code/devices?id=${device}`);
		expect(await status(revoke({ locals: bob, url } as unknown as Event<typeof revoke>))).toBe(404);
		expect(
			await collections.bucketFiles.countDocuments({
				"metadata.conversation": `code:${device}:ses_1`,
			})
		).toBe(1);
	});
});
