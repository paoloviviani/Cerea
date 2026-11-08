import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("$lib/server/gatewayServer", () => ({
	gateway: { post: (...args: unknown[]) => post(...args) },
	GatewayCallFailed: class extends Error {},
}));
vi.mock("$lib/server/logger", () => ({ logger: { warn: vi.fn() } }));

import { embed } from "./embed";

beforeEach(() => {
	post.mockReset();
	post.mockImplementation(async (_t: string, _p: string, body: { input: string[] }) => ({
		data: body.input.map((_, index) => ({ index, embedding: [index] })),
	}));
});

describe("embed prefixes", () => {
	it("sends the texts as they are with no prefix", async () => {
		await embed("t", "m", ["a", "b"]);
		expect(post.mock.calls[0][2].input).toEqual(["a", "b"]);
		await embed("t", "m", ["a"], undefined, "");
		expect(post.mock.calls[1][2].input).toEqual(["a"]);
	});

	it("prepends the prefix to every text, once", async () => {
		await embed("t", "m", ["a", "passage: b"], 8, "passage: ");
		expect(post.mock.calls[0][2]).toMatchObject({
			input: ["passage: a", "passage: b"],
			dimensions: 8,
		});
	});
});
