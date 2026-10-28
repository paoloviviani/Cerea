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
		const flag = (id: string) => built.find((m) => m.id === id)?.toolImages;
		expect(flag("on")).toBe(true);
		expect(flag("switched-off")).toBe(false);
		expect(flag("text-only")).toBe(false);
	});
});

describe("toolImages from a gateway that never lists it", () => {
	it("falls back to accepting images", async () => {
		const built = await build([card("vision", ["tools"]), card("text-only", ["tools"], false)]);
		expect(built.find((m) => m.id === "vision")?.toolImages).toBe(true);
		expect(built.find((m) => m.id === "text-only")?.toolImages).toBe(false);
	});
});

describe("toolImages on a standalone endpoint", () => {
	it("follows image input, and a MODELS override can turn it off", async () => {
		const built = await build(
			[card("a", []), card("b", [])],
			JSON.stringify([{ id: "b", toolImages: false }])
		);
		expect(built.find((m) => m.id === "a")?.toolImages).toBe(true);
		expect(built.find((m) => m.id === "b")?.toolImages).toBe(false);
		// the override changes nothing else
		expect(built.find((m) => m.id === "b")?.multimodal).toBe(true);
	});
});
