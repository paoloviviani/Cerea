import { describe, expect, it } from "vitest";
import { assertModelModeValid, type ModelModeInput } from "./modelMode";

const GATEWAY = "https://pystino.example.org/v1";

const pystino = (extra: ModelModeInput = {}): ModelModeInput => ({
	OPENAI_BASE_URL: GATEWAY,
	USE_USER_TOKEN: "true",
	OPENAI_API_KEY: "",
	...extra,
});

const standalone = (extra: ModelModeInput = {}): ModelModeInput => ({
	OPENAI_BASE_URL: "https://api.example.com/v1",
	OPENAI_API_KEY: "sk-shared",
	USE_USER_TOKEN: "false",
	...extra,
});

describe("accepted modes", () => {
	it("accepts Pystino mode: personal tokens, no key, no overrides", () => {
		expect(assertModelModeValid(pystino())).toBe("pystino");
	});

	it("accepts Pystino mode with overrides that point at the gateway, trailing slash or not", () => {
		const MODELS = JSON.stringify([
			{ id: "a", supportsArtifacts: true },
			{ id: "b", endpoints: [{ type: "openai", baseURL: `${GATEWAY}/` }] },
		]);
		expect(assertModelModeValid(pystino({ MODELS }))).toBe("pystino");
	});

	it("accepts standalone mode: one shared key, personal tokens off", () => {
		expect(assertModelModeValid(standalone())).toBe("standalone");
		expect(assertModelModeValid(standalone({ USE_USER_TOKEN: undefined }))).toBe("standalone");
	});

	it("accepts a standalone override pointing at another endpoint", () => {
		const MODELS = JSON.stringify([
			{ id: "x", endpoints: [{ type: "openai", baseURL: "https://other.example/v1" }] },
		]);
		expect(assertModelModeValid(standalone({ MODELS }))).toBe("standalone");
	});
});

describe("refused mixes", () => {
	it("refuses personal tokens together with OPENAI_API_KEY, naming the setting", () => {
		expect(() => assertModelModeValid(pystino({ OPENAI_API_KEY: "sk-x" }))).toThrow(
			/OPENAI_API_KEY is set while USE_USER_TOKEN=true.*Empty OPENAI_API_KEY \(CHAT_OPENAI_API_KEY in the kit\)/s
		);
	});

	it("treats the legacy HF_TOKEN as a shared key too", () => {
		expect(() => assertModelModeValid(pystino({ HF_TOKEN: "hf_x" }))).toThrow(
			/HF_TOKEN is set while USE_USER_TOKEN=true/
		);
	});

	it("refuses a MODELS override whose endpoint is not the gateway, naming the model", () => {
		const MODELS = JSON.stringify([
			{ id: "gpt-direct", endpoints: [{ type: "openai", baseURL: "https://api.openai.com/v1" }] },
		]);
		expect(() => assertModelModeValid(pystino({ MODELS }))).toThrow(
			/model "gpt-direct" its own endpoint \(https:\/\/api\.openai\.com\/v1\), not the gateway/
		);
	});

	it("refuses an override endpoint with no baseURL (it defaults to api.openai.com)", () => {
		const MODELS = `[{ name: "bare", endpoints: [{ type: "openai" }] }]`;
		expect(() => assertModelModeValid(pystino({ MODELS }))).toThrow(
			/"bare".*no baseURL, which defaults to https:\/\/api\.openai\.com\/v1/s
		);
	});

	it("refuses an override endpoint that carries its own apiKey", () => {
		const MODELS = JSON.stringify([
			{ id: "keyed", endpoints: [{ type: "openai", baseURL: GATEWAY, apiKey: "sk-y" }] },
		]);
		expect(() => assertModelModeValid(pystino({ MODELS }))).toThrow(
			/"keyed" its own apiKey.*Remove "apiKey"/s
		);
	});

	it("refuses personal tokens with no gateway to present them to", () => {
		expect(() => assertModelModeValid(pystino({ OPENAI_BASE_URL: "" }))).toThrow(
			/USE_USER_TOKEN=true.*OPENAI_BASE_URL is not set/s
		);
	});
});
