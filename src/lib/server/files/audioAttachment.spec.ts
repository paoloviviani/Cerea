import { describe, expect, it } from "vitest";
import {
	audioMime,
	formatDuration,
	labelledTranscript,
	missingTranscriptNotice,
} from "./audioAttachment";

/** A box in an MP4: size, type, payload. */
const box = (type: string, payload: Buffer) => {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(8 + payload.length, 0);
	head.write(type, 4, "latin1");
	return Buffer.concat([head, payload]);
};
/** An `hdlr` box naming a track kind. */
const handler = (kind: "vide" | "soun") =>
	box("hdlr", Buffer.concat([Buffer.alloc(8), Buffer.from(kind, "latin1"), Buffer.alloc(12)]));
const mp4Of = (...kinds: ("vide" | "soun")[]) =>
	Buffer.concat([box("ftyp", Buffer.from("isom")), ...kinds.map(handler)]);
const webmOf = (...codecs: string[]) =>
	Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), ...codecs.map((c) => Buffer.from(c))]);

describe("audioMime: decided by the bytes, not the client's word", () => {
	const none = new Uint8Array();

	it("takes the audio formats the bytes sniff as, under one canonical type", () => {
		expect(audioMime("audio/mpeg", none)).toBe("audio/mpeg");
		expect(audioMime("audio/x-m4a", none)).toBe("audio/mp4");
		expect(audioMime("audio/vnd.wave", none)).toBe("audio/wav");
		expect(audioMime("audio/opus", none)).toBe("audio/ogg");
		expect(audioMime("audio/x-flac", none)).toBe("audio/flac");
	});

	it("takes an MP4 or WebM container with no video track", () => {
		expect(audioMime("video/mp4", mp4Of("soun"))).toBe("audio/mp4");
		expect(audioMime("video/webm", webmOf("A_OPUS"))).toBe("audio/webm");
	});

	it("leaves a container with a video track alone, however it was declared", () => {
		expect(audioMime("video/mp4", mp4Of("vide", "soun"))).toBeNull();
		expect(audioMime("video/webm", webmOf("V_VP9", "A_OPUS"))).toBeNull();
	});

	it("is null for no signature, an unknown container, and every non-audio type", () => {
		expect(audioMime(undefined, none)).toBeNull();
		expect(audioMime("application/ogg", none)).toBeNull();
		expect(audioMime("audio/x-unheard-of", none)).toBeNull();
		expect(audioMime("application/pdf", none)).toBeNull();
		expect(audioMime("image/png", none)).toBeNull();
	});
});

describe("transcript wording", () => {
	it("formats durations", () => {
		expect(formatDuration(5)).toBe("0:05");
		expect(formatDuration(205)).toBe("3:25");
		expect(formatDuration(3727)).toBe("1:02:07");
	});

	it("labels the transcript with the name, duration and language", () => {
		const text = labelledTranscript("memo.m4a", "hello there", {
			durationSeconds: 205,
			language: "en",
		});
		expect(text).toContain('"memo.m4a"');
		expect(text).toContain("duration 3:25");
		expect(text).toContain("language en");
		expect(text.endsWith("hello there")).toBe(true);
	});

	it("labels it with just the name when nothing else is known", () => {
		const text = labelledTranscript("a.mp3", "hi", undefined);
		expect(text).toContain('Transcript of the audio file "a.mp3",');
		expect(text).not.toContain("duration");
	});

	it("says there is no transcript, and why", () => {
		const text = missingTranscriptNotice("a.mp3", {
			kind: "no-reader",
			reason: "No transcription model is set up.",
		});
		expect(text).toContain("no transcript");
		expect(text).toContain("No transcription model is set up.");
		expect(missingTranscriptNotice("a.mp3", undefined)).toContain("not recorded");
	});
});
