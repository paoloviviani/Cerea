/** The flags that depend on the transcription catalogue: one probe per request, and a slow gateway means off. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveMock, imageMock, state } = vi.hoisted(() => ({
	resolveMock: vi.fn(),
	imageMock: vi.fn(),
	state: { value: "model", pair: false },
}));

vi.mock("$lib/server/transcription", () => ({
	resolveTranscriptionModel: resolveMock,
	legacyTranscriptionConfigured: () => state.pair,
}));
vi.mock("$lib/server/imageGeneration", () => ({ resolveImageModel: imageMock }));
vi.mock("$lib/server/config", () => ({
	config: new Proxy(
		{},
		{
			get(_t, key: string) {
				return key === "CHAT_DICTATION" ? state.value : undefined;
			},
		}
	),
}));
vi.mock("$lib/server/api/utils/superjsonResponse", () => ({
	superjsonResponse: (body: unknown) => new Response(JSON.stringify(body)),
}));
vi.mock("$lib/server/auth", () => ({ loginEnabled: false, OIDConfig: {} }));
vi.mock("$lib/server/knowledgeEnabled", () => ({ knowledgeEnabled: () => false }));
vi.mock("$lib/server/memoryEnabled", () => ({ memoryEnabled: () => false }));
vi.mock("$lib/server/delegation", () => ({ delegationEnabled: () => false }));
vi.mock("$lib/server/codeEnabled", () => ({ codeAgentsAllowedFor: async () => false }));
vi.mock("$lib/server/code/machineAuth", () => ({ machineClientId: () => "" }));
vi.mock("$lib/server/codeRunLimit", () => ({ codeRunTimeoutMs: () => 60000 }));
vi.mock("$lib/server/codeExecution/backend", () => ({
	executionBackend: () => ({ kind: "browser" }),
}));

import { GET } from "./+server";

const flags = async (token: string | undefined) =>
	(await GET({ locals: { token, isAdmin: false } } as unknown as Parameters<typeof GET>[0])).json();

beforeEach(() => {
	vi.clearAllMocks();
	state.value = "model";
	state.pair = false;
	imageMock.mockResolvedValue({ model: null, source: "none" });
	resolveMock.mockResolvedValue({ model: null, source: "none" });
});

describe("feature flags: image generation", () => {
	it("is on for a user an image model resolves for, off otherwise or without a token", async () => {
		imageMock.mockResolvedValue({ model: "flux-2-klein-4b", source: "first-available" });
		expect(await flags("tok")).toMatchObject({ imageGeneration: true });
		imageMock.mockResolvedValue({ model: null, source: "none" });
		expect(await flags("tok")).toMatchObject({ imageGeneration: false });
		imageMock.mockClear();
		expect(await flags(undefined)).toMatchObject({ imageGeneration: false });
		expect(imageMock).not.toHaveBeenCalled();
	});
});

describe("feature flags: transcription", () => {
	it("asks the catalogue once per request for both the recorder and the audio attachments", async () => {
		resolveMock.mockResolvedValue({ model: "whisper", source: "first-available" });
		const body = await flags("tok");
		expect(resolveMock).toHaveBeenCalledTimes(1);
		expect(body).toMatchObject({
			transcriptionEnabled: true,
			audioAttachments: true,
			dictationBrowser: false,
		});
	});

	it("is off, not slow, when the catalogue probe came back empty (timeout or failure)", async () => {
		resolveMock.mockResolvedValue({ model: null, source: "none" });
		const body = await flags("tok");
		expect(body).toMatchObject({ transcriptionEnabled: false, audioAttachments: false });
	});

	it("asks nothing without a token", async () => {
		const body = await flags(undefined);
		expect(resolveMock).not.toHaveBeenCalled();
		expect(body).toMatchObject({ transcriptionEnabled: false, audioAttachments: false });
	});

	it("keeps the recorder of the legacy pair even when the catalogue is empty", async () => {
		state.pair = true;
		state.value = "no";
		resolveMock.mockResolvedValue({ model: null, source: "none" });
		expect(await flags("tok")).toMatchObject({
			transcriptionEnabled: true,
			dictationBrowser: false,
			dictationMode: "model",
		});
	});
});
