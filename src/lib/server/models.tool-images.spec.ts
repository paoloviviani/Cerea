/**
 * `toolImages`: whether a model may be shown pictures in a tool turn (look_doc).
 *
 * Pystino lists `tool_images` in `supported_features` per model (an admin switches it off per model). A
 * gateway that never lists it (an older Pystino, a plain endpoint) says nothing, so there the rule is
 * "accepts images", and a MODELS override can turn it off. `models.ts` builds its catalogue at module
 * scope, so each case imports a fresh copy under its own listing and environment.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const BASE_URL = "http://tool-images-models.test.invalid/v1";
const env: Record<string, string | undefined> = {};

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_ORIGIN: "https://vitest.invalid" } }));
vi.mock("$env/dynamic/private", () => ({ env }));

type Card = Record<string, unknown>;

async function build(data: Card[], modelsEnv?: string) {
	Object.keys(env).forEach((k) => delete env[k]);
	Object.assign(env, {
		// Without a MONGODB_URL the database module starts mongodb-memory-server, which needs AVX.
		MONGODB_URL: process.env.TEST_MONGODB_URL,
		OPENAI_BASE_URL: BASE_URL,
		OPENAI_API_KEY: "not-used",
		...(modelsEnv ? { MODELS: modelsEnv } : {}),
	});
	vi.resetModules();
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === `${BASE_URL}/models`) {
			return new Response(JSON.stringify({ object: "list", data }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return realFetch(input, init);
	}) as typeof fetch;
	try {
		return (await import("./models")).models;
	} finally {
		globalThis.fetch = realFetch;
	}
}

const card = (id: string, features: string[], image = true): Card => ({
	id,
	kind: "chat",
	input_modalities: image ? ["text", "image"] : ["text"],
	supported_features: features,
});

afterEach(() => vi.resetModules());

describe("toolImages from a gateway that knows the capability", () => {
	it("is on only for an image model that lists tool_images", async () => {
		const built = await build([
			card("on", ["tools", "tool_images"]),
			card("switched-off", ["tools"]),
			card("text-only", ["tools", "tool_images"], false),
		]);
		const flag = (id: string) => built.find((m) => m.id === id)?.toolImagesOff;
		expect(flag("on")).toBe(false);
		expect(flag("switched-off")).toBe(true);
		// not an image model: not "explicitly off" either, the multimodal flag decides
		expect(flag("text-only")).toBe(false);
	});
});

describe("toolImages from a gateway that never lists it", () => {
	it("falls back to accepting images", async () => {
		const built = await build([card("vision", ["tools"]), card("text-only", ["tools"], false)]);
		expect(built.find((m) => m.id === "vision")?.toolImagesOff).toBe(false);
		expect(built.find((m) => m.id === "text-only")?.toolImagesOff).toBe(false);
	});
});

describe("toolImages on a standalone endpoint", () => {
	it("follows image input, and a MODELS override can turn it off", async () => {
		const built = await build(
			[card("a", []), card("b", [])],
			JSON.stringify([{ id: "b", toolImages: false }])
		);
		expect(built.find((m) => m.id === "a")?.toolImagesOff).toBe(false);
		expect(built.find((m) => m.id === "b")?.toolImagesOff).toBe(true);
		// the override changes nothing else
		expect(built.find((m) => m.id === "b")?.multimodal).toBe(true);
	});
});

describe("toolImagesOff and MODELS overrides", () => {
	it("a multimodal: true override on a listing without image input is not off", async () => {
		const built = await build(
			[card("plain", [], false), card("other", ["tool_images"])],
			JSON.stringify([{ id: "plain", multimodal: true }])
		);
		const plain = built.find((m) => m.id === "plain");
		expect(plain?.multimodal).toBe(true);
		expect(plain?.toolImagesOff).toBe(false);
	});

	it("the same holds on a gateway that knows the capability and lists it for no one else", async () => {
		const built = await build(
			[card("plain", ["tools"], false), card("other", ["tool_images"])],
			JSON.stringify([{ id: "plain", multimodal: true }])
		);
		expect(built.find((m) => m.id === "plain")?.toolImagesOff).toBe(false);
	});

	it("an override with its own endpoints does not inherit the listing's off", async () => {
		const own = [{ type: "openai", baseURL: "http://elsewhere.test.invalid/v1" }];
		const built = await build(
			[card("a", ["tools"]), card("b", ["tools"]), card("on", ["tool_images"])],
			JSON.stringify([{ id: "a", endpoints: own }])
		);
		expect(built.find((m) => m.id === "a")?.toolImagesOff).toBe(false);
		expect(built.find((m) => m.id === "b")?.toolImagesOff).toBe(true);
	});

	it("an explicit toolImages: false still wins on an override with its own endpoints", async () => {
		const own = [{ type: "openai", baseURL: "http://elsewhere.test.invalid/v1" }];
		const built = await build(
			[card("a", [])],
			JSON.stringify([{ id: "a", endpoints: own, toolImages: false }])
		);
		expect(built.find((m) => m.id === "a")?.toolImagesOff).toBe(true);
	});
});
