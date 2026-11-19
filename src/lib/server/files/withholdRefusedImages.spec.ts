/**
 * A request the gateway refused under a privacy rule (403, code
 * `routing_refused`) with pictures in it: the pictures are withheld exactly
 * like a file whose extraction was refused. Real bucket.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import type { Message, MessageFile } from "$lib/types/Message";
import { downloadFile, openFile } from "./downloadFile";
import { uploadFile } from "./uploadFile";
import { deleteConversationAttachments } from "./deleteConversationAttachments";
import { withholdRefusedImages } from "./withholdRefusedImages";
import { planAttachments } from "$lib/utils/execution/attachmentNames";

const PNG = () =>
	new File([Buffer.from("\x89PNG\r\n\x1a\n pixels of a face")], "face.png", { type: "image/png" });
const TXT = () => new File([Buffer.from("hello")], "note.txt", { type: "text/plain" });

/** What the OpenAI SDK throws for the gateway's 403 body. */
function refusal(message: string, code = "routing_refused") {
	return Object.assign(new Error(`403 ${message}`), {
		status: 403,
		code,
		error: { message, type: "invalid_request_error", code },
	});
}

const conversations: ObjectId[] = [];
beforeAll(async () => {
	await ready;
});
afterAll(async () => {
	for (const id of conversations) {
		await deleteConversationAttachments(id);
		await collections.conversations.deleteOne({ _id: id });
	}
});

async function setup() {
	const _id = new ObjectId();
	conversations.push(_id);
	const conv = {
		_id,
		messages: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as unknown as Conversation;
	const image = await uploadFile(PNG(), conv, "t");
	const text = await uploadFile(TXT(), conv, "t");
	const messages = [
		{ id: "m1", from: "user", content: "look", files: [image, text], createdAt: new Date() },
		{ id: "m2", from: "assistant", content: "", createdAt: new Date() },
	] as unknown as Message[];
	await collections.conversations.insertOne({ ...conv, messages } as never);
	return { _id, image, text, messages };
}

const MESSAGE =
	"Refused by the privacy rule 'no-faces' (pipeline 'strict'): this request is not allowed.";

describe("a vision request refused by a privacy rule", () => {
	it("withholds the image: stored bytes, MessageFile, sandbox plan", async () => {
		const { _id, image, messages } = await setup();
		const marked = await withholdRefusedImages(_id, messages, refusal(MESSAGE), true);
		expect(marked.map((f) => f.name)).toEqual(["face.png"]);

		await expect(downloadFile(image.value, _id)).rejects.toMatchObject({ status: 403 });
		await expect(openFile(image.value, _id)).rejects.toMatchObject({ status: 403 });

		const stored = await collections.conversations.findOne({ _id });
		const files = stored?.messages[0].files as MessageFile[];
		expect(files[0].withheld).toEqual({ rule: "no-faces", pipeline: "strict" });
		expect(files[1].withheld).toBeUndefined();
		expect(planAttachments(files).map((p) => p.name)).toEqual(["note.txt"]);
		// A text file of the same request stays readable.
		await expect(
			downloadFile(files[1].type === "hash" ? files[1].value : "", _id)
		).resolves.toBeDefined();
	});

	it("does nothing for a technical failure, another 403, or a model that reads no images", async () => {
		const { _id, image, messages } = await setup();
		expect(
			await withholdRefusedImages(
				_id,
				messages,
				refusal("upstream down", "upstream_unavailable"),
				true
			)
		).toEqual([]);
		expect(await withholdRefusedImages(_id, messages, new Error("boom"), true)).toEqual([]);
		expect(await withholdRefusedImages(_id, messages, refusal(MESSAGE), false)).toEqual([]);
		await expect(downloadFile(image.value, _id)).resolves.toBeDefined();
	});

	it("names the rule 'unnamed' when the message does not parse", async () => {
		const { _id, messages } = await setup();
		const [marked] = await withholdRefusedImages(_id, messages, refusal("odd words"), true);
		expect(marked.type === "hash" && marked.value).toBeTruthy();
		const stored = await collections.conversations.findOne({ _id });
		expect(stored?.messages[0].files?.[0].withheld).toEqual({ rule: "unnamed" });
	});
});
