import { beforeEach, describe, expect, it, vi } from "vitest";

const { postForm, get, state } = vi.hoisted(() => ({
	postForm: vi.fn(),
	get: vi.fn(),
	state: { stored: null as string | null, env: "", gatewayUrl: "http://gw" },
}));

vi.mock("$lib/server/config", () => ({
	config: new Proxy({ get: () => "" } as Record<string, unknown>, {
		get(target, key: string) {
			if (key === "get") return target.get;
			if (key === "CHAT_TRANSCRIPTION_MODEL") return state.env;
			if (key === "OPENAI_BASE_URL") return state.gatewayUrl;
			return undefined;
		},
	}),
}));
vi.mock("$lib/server/database", () => ({
	collections: {
		voiceConfig: {
			findOne: vi.fn(async () => (state.stored ? { transcriptionModel: state.stored } : null)),
		},
		knowledgeConfig: { findOne: vi.fn(async () => null) },
	},
}));
vi.mock("$lib/server/gatewayServer", async () => {
	class GatewayCallFailed extends Error {
		constructor(
			readonly status: number,
			message: string,
			readonly code?: string
		) {
			super(message);
		}
	}
	class GatewayTimeout extends GatewayCallFailed {
		constructor() {
			super(504, "timeout");
		}
	}
	return { gateway: { get, postForm }, GatewayCallFailed, GatewayTimeout };
});

import { GatewayCallFailed, GatewayTimeout } from "$lib/server/gatewayServer";
import {
	TRANSCRIPTION_MAX_BYTES,
	clearTranscriptionModelCache,
	resolveTranscription,
	resolveTranscriptionModel,
	transcribeAudio,
} from "./transcription";

beforeEach(() => {
	vi.clearAllMocks();
	clearTranscriptionModelCache();
	state.stored = null;
	state.env = "";
	state.gatewayUrl = "http://gw";
	get.mockResolvedValue({
		data: [
			{ id: "chat-1", kind: "chat" },
			{ id: "whisper-large-v3-turbo", kind: "transcription" },
			{ id: "voxtral-mini", kind: "transcription" },
		],
	});
});

describe("model resolution", () => {
	it("is the admin's choice, then the environment, then the first model", () => {
		const candidates = ["a", "b"];
		expect(resolveTranscription({ storedModel: "s", envModel: "e", candidates })).toEqual({
			model: "s",
			source: "stored",
		});
		expect(resolveTranscription({ storedModel: null, envModel: "e", candidates })).toEqual({
			model: "e",
			source: "env",
		});
		expect(resolveTranscription({ storedModel: null, envModel: null, candidates })).toEqual({
			model: "a",
			source: "first-available",
		});
		expect(resolveTranscription({ storedModel: null, envModel: null, candidates: [] })).toEqual({
			model: null,
			source: "none",
		});
	});

	it("reads kind: transcription from the user's catalogue", async () => {
		expect(await resolveTranscriptionModel("tok")).toEqual({
			model: "whisper-large-v3-turbo",
			source: "first-available",
		});
		expect(get).toHaveBeenCalledWith("tok", "models?include=transcription", {
			timeoutMs: 2000,
		});
	});

	it("does not ask the catalogue when a model is named", async () => {
		state.stored = "chosen";
		expect(await resolveTranscriptionModel("tok")).toEqual({ model: "chosen", source: "stored" });
		state.stored = null;
		state.env = "from-env";
		expect(await resolveTranscriptionModel("tok")).toEqual({ model: "from-env", source: "env" });
		expect(get).not.toHaveBeenCalled();
	});

	it("is none when the catalogue has no such model or cannot be read", async () => {
		get.mockResolvedValueOnce({ data: [{ id: "chat-1", kind: "chat" }] });
		expect((await resolveTranscriptionModel("tok")).model).toBeNull();
		clearTranscriptionModelCache();
		get.mockRejectedValueOnce(new Error("down"));
		expect((await resolveTranscriptionModel("tok")).model).toBeNull();
	});
});

describe("the catalogue probe", () => {
	it("gives up quickly and fails closed: no model, so the audio features stay off", async () => {
		get.mockRejectedValueOnce(new GatewayTimeout(2000, 2000));
		expect(await resolveTranscriptionModel("slow")).toEqual({ model: null, source: "none" });
		expect(get.mock.calls[0][2]).toEqual({ timeoutMs: 2000 });
	});

	it("is asked once for a burst of resolutions, a failure included", async () => {
		get.mockRejectedValueOnce(new Error("down"));
		await Promise.all([
			resolveTranscriptionModel("burst"),
			resolveTranscriptionModel("burst"),
			resolveTranscriptionModel("burst"),
		]);
		expect(get).toHaveBeenCalledTimes(1);
	});
});

describe("transcribeAudio", () => {
	it("clamps a language to a code's length", async () => {
		postForm.mockResolvedValue({ text: "x" });
		await transcribeAudio({
			bytes: new Uint8Array([1]),
			mime: "audio/wav",
			filename: "a.wav",
			token: "t",
			model: "m",
			language: "x".repeat(200),
		});
		expect((postForm.mock.calls[0][2] as FormData).get("language")).toBe("x".repeat(16));
	});

	it("says the cap of a caller that has a lower one, in its own minutes", async () => {
		const result = await transcribeAudio({
			bytes: new Uint8Array(10 * 1024 * 1024 + 1),
			mime: "audio/wav",
			filename: "a.wav",
			token: "t",
			model: "m",
			maxBytes: 10 * 1024 * 1024,
		});
		expect(result).toMatchObject({ ok: false, status: 413 });
		expect((result as { reason: string }).reason).toContain("about 10 minutes");
		expect(postForm).not.toHaveBeenCalled();
	});

	const audio = new Uint8Array([1, 2, 3, 4]);

	it("sends one multipart call with the user's token and returns text, duration and language", async () => {
		postForm.mockResolvedValue({
			text: " hello ",
			language: "en",
			usage: { audio_duration_seconds: 12.5 },
		});
		const result = await transcribeAudio({
			bytes: audio,
			mime: "audio/mpeg",
			filename: "a.mp3",
			token: "user-token",
		});
		expect(result).toEqual({
			ok: true,
			text: "hello",
			model: "whisper-large-v3-turbo",
			durationSeconds: 12.5,
			language: "en",
		});
		expect(postForm).toHaveBeenCalledTimes(1);
		const [token, path, form] = postForm.mock.calls[0];
		expect(token).toBe("user-token");
		expect(path).toBe("audio/transcriptions");
		expect(form.get("model")).toBe("whisper-large-v3-turbo");
		expect((form.get("file") as File).name).toBe("a.mp3");
	});

	it("treats a transcript of dots as empty", async () => {
		postForm.mockResolvedValue({ text: "..." });
		const result = await transcribeAudio({
			bytes: audio,
			mime: "audio/wav",
			filename: "a.wav",
			token: "t",
		});
		expect(result).toMatchObject({ ok: true, text: "" });
	});

	it("says there is no model rather than calling anything", async () => {
		get.mockResolvedValue({ data: [] });
		const result = await transcribeAudio({
			bytes: audio,
			mime: "audio/wav",
			filename: "a",
			token: "t",
		});
		expect(result).toMatchObject({ ok: false, kind: "no-reader", status: 503 });
		expect(postForm).not.toHaveBeenCalled();
	});

	it("needs a credential", async () => {
		const result = await transcribeAudio({
			bytes: audio,
			mime: "audio/wav",
			filename: "a",
			token: undefined,
		});
		expect(result).toMatchObject({ ok: false, kind: "no-credential" });
		expect(postForm).not.toHaveBeenCalled();
	});

	it("refuses a file over the cap with the minutes, without calling the gateway", async () => {
		const big = new Uint8Array(TRANSCRIPTION_MAX_BYTES + 1);
		const result = await transcribeAudio({
			bytes: big,
			mime: "audio/wav",
			filename: "a",
			token: "t",
		});
		expect(result).toMatchObject({ ok: false, status: 413 });
		expect((result as { reason: string }).reason).toMatch(
			/too long to transcribe here: up to 25 MB \(about 25 minutes\)/
		);
		expect(postForm).not.toHaveBeenCalled();
	});

	it("maps the gateway's refusals to a reason", async () => {
		const call = () =>
			transcribeAudio({ bytes: audio, mime: "audio/wav", filename: "a", token: "t", model: "m" });
		postForm.mockRejectedValueOnce(new GatewayCallFailed(413, "big"));
		expect(await call()).toMatchObject({ ok: false, status: 413 });
		postForm.mockRejectedValueOnce(new GatewayCallFailed(403, "no"));
		expect(await call()).toMatchObject({
			ok: false,
			kind: "refused",
			reason: expect.stringContaining("groups"),
		});
		postForm.mockRejectedValueOnce(new GatewayCallFailed(429, "slow"));
		expect(await call()).toMatchObject({ ok: false, kind: "unreachable", status: 429 });
		postForm.mockRejectedValueOnce(new GatewayCallFailed(429, "Quota exceeded.", "quota_exceeded"));
		expect(await call()).toMatchObject({
			ok: false,
			status: 429,
			reason: expect.stringContaining("quota"),
		});
		postForm.mockRejectedValueOnce(new GatewayTimeout(1000, 180000));
		expect(await call()).toMatchObject({ ok: false, status: 504 });
		postForm.mockRejectedValueOnce(new GatewayCallFailed(422, "Unsupported audio"));
		expect(await call()).toMatchObject({ ok: false, kind: "refused", reason: "Unsupported audio" });
		postForm.mockRejectedValueOnce(new Error("boom"));
		expect(await call()).toMatchObject({ ok: false, kind: "unreachable", status: 502 });
	});
});
