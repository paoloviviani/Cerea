/** A file nobody attached (a browser download) is stored as it is: no transcription is bought. */
import { describe, expect, it, vi } from "vitest";
import { ready } from "$lib/server/database";

const transcribeAudio = vi.hoisted(() =>
	vi.fn(async () => ({ ok: true, text: "hello", durationSeconds: 1 }))
);
vi.mock("$lib/server/transcription", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/transcription")>()),
	transcribeAudio,
}));

await ready;
const { writeAttachment } = await import("./uploadFile");

/** A silent 16-bit mono WAV, 100 samples. */
function wav(): Uint8Array {
	const samples = 100;
	const buf = Buffer.alloc(44 + samples * 2);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(36 + samples * 2, 4);
	buf.write("WAVEfmt ", 8);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(8000, 24);
	buf.writeUInt32LE(16000, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(samples * 2, 40);
	return new Uint8Array(buf);
}

describe("writeAttachment, audio", () => {
	it("transcribes an audio attachment, as it always did", async () => {
		transcribeAudio.mockClear();
		const file = await writeAttachment(
			new File([wav() as BlobPart], "note.wav", { type: "audio/wav" }),
			"conv-a",
			"token"
		);
		expect(transcribeAudio).toHaveBeenCalledTimes(1);
		expect(file.mime.startsWith("audio/")).toBe(true);
	});

	it("stores it as it is, with no transcription call, when asked not to", async () => {
		transcribeAudio.mockClear();
		const file = await writeAttachment(
			new File([wav() as BlobPart], "download.wav", { type: "audio/wav" }),
			"conv-b",
			"token",
			undefined,
			{ skipTranscription: true }
		);
		expect(transcribeAudio).not.toHaveBeenCalled();
		expect(file).toMatchObject({ type: "hash", name: "download.wav" });
		expect(file.extractionError).toBeUndefined();
	});
});
