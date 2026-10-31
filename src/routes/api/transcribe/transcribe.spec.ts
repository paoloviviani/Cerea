import { beforeEach, describe, expect, it, vi } from "vitest";

const { state, transcribeMock, fetchMock } = vi.hoisted(() => ({
	state: { mode: "model", legacy: false, token: "user-token" as string | undefined },
	transcribeMock: vi.fn(),
	fetchMock: vi.fn(),
}));

vi.mock("$lib/server/dictation", () => ({ dictationMode: () => state.mode }));
vi.mock("$lib/server/apiToken", () => ({ getApiToken: () => "deployment-key" }));
vi.mock("$lib/server/config", () => ({
	config: {
		get: (key: string) => (key === "TRANSCRIPTION_MODEL" ? "legacy-whisper" : ""),
	},
}));
vi.mock("$lib/server/transcription", () => ({
	TRANSCRIPTION_MAX_BYTES: 25 * 1024 * 1024,
	TRANSCRIPTION_CAP_MINUTES: 25,
	legacyTranscriptionConfigured: () => state.legacy,
	transcriptionBaseUrl: () => "https://stt.example.org/models",
	warnLegacyTranscription: vi.fn(),
	transcribeAudio: transcribeMock,
}));

import { POST } from "./+server";

function post(body: BodyInit | null, type = "audio/webm;codecs=opus") {
	return POST({
		locals: { token: state.token, billingOrganization: "org-1" },
		request: new Request("http://localhost/api/transcribe", {
			method: "POST",
			headers: { "content-type": type },
			body,
		}),
	} as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	state.mode = "model";
	state.legacy = false;
	state.token = "user-token";
	vi.stubGlobal("fetch", fetchMock);
});

describe("POST /api/transcribe through the gateway", () => {
	it("sends the recording as the user, with their bill-to, and returns the text", async () => {
		transcribeMock.mockResolvedValue({ ok: true, text: "hello world", model: "whisper" });
		const res = await post(new Uint8Array([1, 2, 3]));

		expect(await res.json()).toEqual({ text: "hello world" });
		expect(transcribeMock).toHaveBeenCalledTimes(1);
		expect(transcribeMock.mock.calls[0][0]).toMatchObject({
			token: "user-token",
			mime: "audio/webm",
			billHeaders: { "x-bill-to": "org-1" },
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("is closed unless the administrator chose the transcription model", async () => {
		for (const mode of ["browser", "off"]) {
			state.mode = mode;
			await expect(post(new Uint8Array([1]))).rejects.toMatchObject({ status: 403 });
		}
		expect(transcribeMock).not.toHaveBeenCalled();
	});

	it("needs a token", async () => {
		state.token = undefined;
		await expect(post(new Uint8Array([1]))).rejects.toMatchObject({ status: 401 });
	});

	it("refuses what is not audio", async () => {
		await expect(post("x", "text/plain")).rejects.toMatchObject({ status: 400 });
	});

	it("refuses a recording past the cap with the minutes", async () => {
		await expect(post(new Uint8Array(25 * 1024 * 1024 + 1))).rejects.toMatchObject({
			status: 413,
			body: { message: expect.stringContaining("about 25 minutes") },
		});
		expect(transcribeMock).not.toHaveBeenCalled();
	});

	it("passes the gateway's failure on with its reason", async () => {
		transcribeMock.mockResolvedValue({
			ok: false,
			kind: "refused",
			status: 403,
			reason: "The transcription model whisper isn't available to your groups.",
		});
		await expect(post(new Uint8Array([1]))).rejects.toMatchObject({
			status: 403,
			body: { message: expect.stringContaining("groups") },
		});
	});
});

describe("POST /api/transcribe with the deprecated direct endpoint", () => {
	it("still goes direct when it is set, without touching the gateway path", async () => {
		state.legacy = true;
		const calls = fetchMock.mock.calls;
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ text: " legacy text " }), { status: 200 })
		);
		const res = await post(new Uint8Array([1, 2]));

		expect(await res.json()).toEqual({ text: "legacy text" });
		expect(calls[0][0]).toBe("https://stt.example.org/models/legacy-whisper");
		// The credential it always had, as before.
		expect(calls[0][1].headers.Authorization).toBe("Bearer deployment-key");
		expect(transcribeMock).not.toHaveBeenCalled();
	});
});
