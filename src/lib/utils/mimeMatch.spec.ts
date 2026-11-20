import { describe, expect, it } from "vitest";
import { AUDIO_MIME_ALLOWLIST } from "$lib/constants/mime";
import { fileMatchesAllowlist, mimeEssence, mimeMatchesAllowlist } from "./mimeMatch";

describe("mimeMatchesAllowlist", () => {
	it("matches exact types", () => {
		expect(mimeMatchesAllowlist("image/png", ["image/png"])).toBe(true);
		expect(mimeMatchesAllowlist("image/png", ["image/jpeg", "image/png"])).toBe(true);
	});

	it("matches wildcard subtypes", () => {
		expect(mimeMatchesAllowlist("text/plain", ["text/*"])).toBe(true);
		expect(mimeMatchesAllowlist("text/markdown", ["text/*"])).toBe(true);
		expect(mimeMatchesAllowlist("image/png", ["text/*"])).toBe(false);
	});

	it("matches a full wildcard", () => {
		expect(mimeMatchesAllowlist("application/pdf", ["*/*"])).toBe(true);
	});

	it("rejects types not in the allowlist", () => {
		expect(mimeMatchesAllowlist("image/png", ["text/*", "application/json"])).toBe(false);
		expect(mimeMatchesAllowlist("image/svg+xml", ["image/png", "image/jpeg"])).toBe(false);
	});

	it("rejects everything on an empty allowlist", () => {
		expect(mimeMatchesAllowlist("image/png", [])).toBe(false);
	});
});

describe("fileMatchesAllowlist", () => {
	const accept = ["text/*", "application/pdf"];

	it("does not turn away text by its extension or type: the server reads the bytes", () => {
		for (const name of ["rows.jsonl", "diagram.drawio", "scene.excalidraw", "x.foo", "Makefile"]) {
			for (const type of ["", "application/octet-stream", "application/x-ndjson"]) {
				expect(fileMatchesAllowlist({ name, type }, accept)).toBe(true);
			}
		}
	});

	it("still judges images and audio by type, and everything when text is not taken", () => {
		expect(fileMatchesAllowlist({ name: "a.png", type: "image/png" }, accept)).toBe(false);
		expect(fileMatchesAllowlist({ name: "a.mp3", type: "audio/mpeg" }, accept)).toBe(false);
		expect(fileMatchesAllowlist({ name: "a.png", type: "image/png" }, ["image/*"])).toBe(true);
		expect(fileMatchesAllowlist({ name: "a.foo", type: "" }, ["image/*"])).toBe(false);
	});
});

describe("audio the browsers name in their own ways", () => {
	const audio = [
		"audio/mpeg",
		"audio/mp4",
		"audio/ogg",
		"audio/mp4a-latm",
		"audio/x-opus+ogg",
		".m4a",
		".opus",
	];

	it("ignores a codec parameter and the case of the type", () => {
		expect(mimeMatchesAllowlist("audio/ogg; codecs=opus", audio)).toBe(true);
		expect(mimeMatchesAllowlist("Audio/MP4;codecs=mp4a.40.2", audio)).toBe(true);
		expect(mimeEssence(" Audio/Ogg ; codecs=opus")).toBe("audio/ogg");
	});

	it("takes an .opus and an .m4a by extension when the type is empty or odd", () => {
		for (const type of [
			"",
			"audio/ogg; codecs=opus",
			"audio/x-opus+ogg",
			"application/octet-stream",
		]) {
			expect(fileMatchesAllowlist({ name: "Note.OPUS", type }, audio)).toBe(true);
		}
		for (const type of ["", "audio/mp4a-latm", "audio/mp4", "audio/x-m4a"]) {
			expect(fileMatchesAllowlist({ name: "rec.m4a", type }, audio)).toBe(true);
		}
		expect(fileMatchesAllowlist({ name: "x.opus", type: "audio/x-opus+ogg" }, ["audio/mpeg"])).toBe(
			false
		);
	});

	it("takes the audio aliases of the real list", () => {
		for (const type of [
			"audio/mp4a-latm",
			"audio/3gpp",
			"audio/x-opus+ogg",
			"audio/ogg; codecs=opus",
		]) {
			expect(fileMatchesAllowlist({ name: "x", type }, [...AUDIO_MIME_ALLOWLIST])).toBe(true);
		}
		expect(fileMatchesAllowlist({ name: "a.m4a", type: "" }, [...AUDIO_MIME_ALLOWLIST])).toBe(true);
		expect(fileMatchesAllowlist({ name: "a.opus", type: "" }, [...AUDIO_MIME_ALLOWLIST])).toBe(
			true
		);
	});
});
