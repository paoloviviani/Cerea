/**
 * An audio attachment: transcribed once, at upload, through the gateway as the
 * user, and the transcript stored beside the file like a document's text. The
 * gateway is mocked; the bucket and the type sniffing are real.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const { postForm, get } = vi.hoisted(() => ({ postForm: vi.fn(), get: vi.fn() }));

vi.mock("$lib/server/gatewayServer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/gatewayServer")>();
	return { ...actual, gateway: { ...actual.gateway, get, postForm } };
});

import { collections, ready } from "$lib/server/database";
import { GatewayCallFailed } from "$lib/server/gatewayServer";
import type { Conversation } from "$lib/types/Conversation";
import type { Message } from "$lib/types/Message";
import { uploadFile } from "./uploadFile";
import { storeAttachment, findAttachments, deleteAttachmentsByPrefix } from "./attachmentStore";
import { deleteConversationAttachments } from "./deleteConversationAttachments";
import { downloadFile } from "./downloadFile";
import { findBlobs } from "$lib/server/blobs/testing";
import { preprocessMessages } from "$lib/server/endpoints/preprocessMessages";
import { clearTranscriptionModelCache, TRANSCRIPTION_MAX_BYTES } from "$lib/server/transcription";

beforeAll(async () => {
	await ready;
});

const conversations: ObjectId[] = [];
const devices: string[] = [];

afterEach(async () => {
	vi.clearAllMocks();
	clearTranscriptionModelCache();
	for (const id of devices.splice(0)) await deleteAttachmentsByPrefix(`code:${id}:`);
	const ids = conversations.splice(0);
	await deleteConversationAttachments(ids);
	await collections.conversations.deleteMany({ _id: { $in: ids } });
});

function conversation(): Conversation {
	const _id = new ObjectId();
	conversations.push(_id);
	return { _id } as Conversation;
}

/** A real, minimal WAV: what `file-type` recognises as audio. */
function wav(extra = 0): Buffer {
	const data = Buffer.alloc(800 + extra);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(8000, 24);
	header.writeUInt32LE(16000, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

const audioFile = (name = "memo.wav", type = "audio/wav", bytes = wav()) =>
	new File([bytes as BlobPart], name, { type });

const models = { data: [{ id: "whisper-large-v3-turbo", kind: "transcription" }] };

describe("uploadFile: audio", () => {
	it("transcribes once, with the user's token, and stores the transcript beside the file", async () => {
		get.mockResolvedValue(models);
		postForm.mockResolvedValue({
			text: "Good morning everyone.",
			language: "en",
			usage: { audio_duration_seconds: 185 },
		});
		const conv = conversation();
		const stored = await uploadFile(audioFile(), conv, "user-token");

		expect(postForm).toHaveBeenCalledTimes(1);
		expect(postForm.mock.calls[0][0]).toBe("user-token");
		expect(postForm.mock.calls[0][1]).toBe("audio/transcriptions");
		expect(stored.mime).toMatch(/^audio\//);
		expect(stored.extracted).toMatchObject({ pages: 0 });
		expect(stored.audio).toEqual({ durationSeconds: 185, language: "en" });
		expect(stored.extractionError).toBeUndefined();

		const text = await downloadFile((stored.extracted as { value: string }).value, conv._id);
		expect(Buffer.from(text.value, "base64").toString("utf-8")).toBe("Good morning everyone.");
		// The bytes and the transcript: two entries, nothing else.
		expect(await findBlobs({ "metadata.conversation": conv._id.toString() })).toHaveLength(2);
	});

	it("gives the turn the labelled transcript as the attachment's content", async () => {
		get.mockResolvedValue(models);
		postForm.mockResolvedValue({ text: "Buy milk.", usage: { audio_duration_seconds: 65 } });
		const conv = conversation();
		const stored = await uploadFile(audioFile("shopping.wav"), conv, "tok");

		const message = { id: "m1", from: "user", content: "what?", files: [stored] } as Message;
		const [out] = await preprocessMessages([message], conv._id);
		const file = out.files?.[0];
		expect(file).toMatchObject({ mime: "text/markdown", name: "shopping.wav" });
		const body = Buffer.from(file?.value ?? "", "base64").toString("utf-8");
		expect(body).toContain('"shopping.wav"');
		expect(body).toContain("duration 1:05");
		expect(body).toContain("Buy milk.");
		// No second transcription for the turn.
		expect(postForm).toHaveBeenCalledTimes(1);
	});

	it("keeps the file and says so in the prompt when transcription fails", async () => {
		get.mockResolvedValue(models);
		postForm.mockRejectedValue(new GatewayCallFailed(502, "upstream"));
		const conv = conversation();
		const stored = await uploadFile(audioFile(), conv, "tok");

		expect(stored.extracted).toBeUndefined();
		expect(stored.extractionError).toMatchObject({ kind: "unreachable" });
		const [out] = await preprocessMessages(
			[{ id: "m1", from: "user", content: "x", files: [stored] } as Message],
			conv._id
		);
		const body = Buffer.from(out.files?.[0].value ?? "", "base64").toString("utf-8");
		expect(body).toContain("has no transcript");
		expect(body).toContain("Say so");
		expect(await findBlobs({ "metadata.conversation": conv._id.toString() })).toHaveLength(1);
	});

	it("says there is no model when the catalogue has none, without calling the gateway", async () => {
		get.mockResolvedValue({ data: [] });
		const stored = await uploadFile(audioFile(), conversation(), "tok");
		expect(postForm).not.toHaveBeenCalled();
		expect(stored.extractionError?.kind).toBe("no-reader");
		expect(stored.extractionError?.reason).toMatch(/No transcription model/);
	});

	it("says the recording is too long over the attachment cap, without sending it", async () => {
		get.mockResolvedValue(models);
		const big = wav(TRANSCRIPTION_MAX_BYTES);
		const stored = await uploadFile(audioFile("long.wav", "audio/wav", big), conversation(), "tok");
		expect(postForm).not.toHaveBeenCalled();
		expect(stored.extractionError?.reason).toMatch(
			/too long to transcribe here; up to about 10 minutes/
		);
	});

	it("records an empty transcript as no speech", async () => {
		get.mockResolvedValue(models);
		postForm.mockResolvedValue({ text: "" });
		const stored = await uploadFile(audioFile(), conversation(), "tok");
		expect(stored.extractionError?.kind).toBe("empty");
	});

	it("does not transcribe a file only the client calls audio, and stores no audio type for it", async () => {
		get.mockResolvedValue(models);
		const text = new File([Buffer.from("just some words, no sound at all")], "words.mp3", {
			type: "audio/mpeg",
		});
		const stored = await uploadFile(text, conversation(), "tok");
		expect(postForm).not.toHaveBeenCalled();
		expect(stored.mime).toBe("application/octet-stream");
		expect(stored.audio).toBeUndefined();
	});

	it("does not transcribe a video declared audio/mp4, and keeps its real type", async () => {
		get.mockResolvedValue(models);
		const video = Buffer.concat([
			Buffer.from([0, 0, 0, 0x18]),
			Buffer.from("ftypisom"),
			Buffer.alloc(8),
			// An hdlr box for a video track.
			Buffer.from([0, 0, 0, 0x20]),
			Buffer.from("hdlr"),
			Buffer.alloc(8),
			Buffer.from("vide"),
			Buffer.alloc(16),
		]);
		const stored = await uploadFile(
			new File([video as BlobPart], "clip.m4a", { type: "audio/mp4" }),
			conversation(),
			"tok"
		);
		expect(postForm).not.toHaveBeenCalled();
		expect(stored.mime).not.toMatch(/^audio\//);
	});

	it("stores the sniffed audio type, not the client's string", async () => {
		get.mockResolvedValue(models);
		postForm.mockResolvedValue({ text: "hello" });
		const stored = await uploadFile(
			audioFile("memo.wav", "audio/x-made-up"),
			conversation(),
			"tok"
		);
		expect(stored.mime).toBe("audio/wav");
		expect((postForm.mock.calls[0][2] as FormData).get("file")).toHaveProperty("type", "audio/wav");
	});

	it("survives the owner-keyed store's rebuild from the bucket, duration and language included", async () => {
		get.mockResolvedValue(models);
		postForm.mockResolvedValue({
			text: "hi",
			language: "fr",
			usage: { audio_duration_seconds: 9 },
		});
		const device = new ObjectId().toHexString();
		devices.push(device);
		const key = `code:${device}:ses_x`;
		const stored = await storeAttachment(audioFile(), key, "msg-1", "tok");
		expect(stored.audio).toEqual({ durationSeconds: 9, language: "fr" });
		expect(await findAttachments(key, "msg-1")).toEqual([stored]);
	});
});
