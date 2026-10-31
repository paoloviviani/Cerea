import { describe, expect, it } from "vitest";
import {
	audioMime,
	formatDuration,
	labelledTranscript,
	missingTranscriptNotice,
} from "./audioAttachment";

describe("audioMime", () => {
	it("takes anything the bytes sniff as audio", () => {
		expect(audioMime("audio/mpeg", "", "talk.mp3")).toBe("audio/mpeg");
		expect(audioMime("audio/x-m4a", "audio/mp4", "memo.m4a")).toBe("audio/x-m4a");
		expect(audioMime("audio/ogg", "", "a.ogg")).toBe("audio/ogg");
		expect(audioMime("audio/flac", "", "a.flac")).toBe("audio/flac");
	});

	it("takes an mp4/webm/ogg container when the browser says audio", () => {
		expect(audioMime("video/mp4", "audio/mp4", "memo.m4a")).toBe("audio/mp4");
		expect(audioMime("video/webm", "audio/webm", "rec.webm")).toBe("audio/webm");
	});

	it("takes such a container by an audio extension when the browser said nothing", () => {
		expect(audioMime("video/webm", "", "rec.webm")).toBe("audio/webm");
		expect(audioMime("application/ogg", "", "rec.opus")).toBe("audio/ogg");
	});

	it("leaves a real video alone", () => {
		expect(audioMime("video/mp4", "video/mp4", "clip.mp4")).toBeNull();
		expect(audioMime("video/mp4", "", "clip.mp4")).toBeNull();
	});

	it("is null for everything else", () => {
		expect(audioMime("application/pdf", "application/pdf", "a.pdf")).toBeNull();
		expect(audioMime("image/png", "image/png", "a.png")).toBeNull();
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
