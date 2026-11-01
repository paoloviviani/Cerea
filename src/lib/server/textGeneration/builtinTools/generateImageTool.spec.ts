import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const { post, store } = vi.hoisted(() => ({ post: vi.fn(), store: vi.fn() }));

vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/server/config", () => ({ config: { OPENAI_BASE_URL: "http://gw" } }));
vi.mock("$lib/server/database", () => ({ collections: {} }));
vi.mock("$lib/server/execution/deliverables", () => ({ storeDeliverable: store }));
vi.mock("$lib/server/urlSafety", () => ({ contentFetch: vi.fn() }));
vi.mock("$lib/server/gatewayServer", async () => {
	class GatewayCallFailed extends Error {
		constructor(
			readonly status: number,
			message: string
		) {
			super(message);
		}
	}
	class GatewayTimeout extends GatewayCallFailed {}
	return { gateway: { get: vi.fn(), post }, GatewayCallFailed, GatewayTimeout };
});

import { GatewayCallFailed } from "$lib/server/gatewayServer";
import { MessageCodeExecutionUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import { createGenerateImageBuiltin, GENERATE_IMAGE_TOOL_NAME } from "./generateImageTool";
import { getEnabledBuiltinTools } from "./index";

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]);
const answer = (count: number, revised?: string) => ({
	data: Array.from({ length: count }, () => ({
		b64_json: PNG.toString("base64"),
		...(revised ? { revised_prompt: revised } : {}),
	})),
});

function tool(options: { sees?: boolean; unavailable?: boolean } = {}) {
	const [built] = createGenerateImageBuiltin({
		model: "flux-2-klein-4b",
		token: "tok",
		billHeaders: { "x-bill-to": "org" },
		modelSeesImages: options.sees,
		pictureState: { unavailable: options.unavailable ?? false },
	});
	return built;
}
const ctx = () => ({
	uuid: "u",
	toolCallId: "c",
	conversationId: new ObjectId(),
	userId: new ObjectId(),
	messageId: "m1",
});

beforeEach(() => {
	vi.clearAllMocks();
	store.mockImplementation(async (input: { name: string; bytes: Buffer }) => ({
		ok: true,
		ref: { name: input.name, size: input.bytes.byteLength, sha256: "b".repeat(64) },
	}));
});

describe("generate_image", () => {
	it("stores the image as a produced file and lists it through an Outputs update", async () => {
		post.mockResolvedValue(answer(1, "a red fox in the snow"));
		const result = await tool().execute({ prompt: "a red fox" }, ctx());
		if (!("resultText" in result)) throw new Error(JSON.stringify(result));
		expect(post.mock.calls[0][0]).toBe("tok");
		expect(post.mock.calls[0][1]).toBe("images/generations");
		expect(post.mock.calls[0][3]).toMatchObject({ headers: { "x-bill-to": "org" } });
		expect(store).toHaveBeenCalledWith(
			expect.objectContaining({ name: "image-a-red-fox.png", mime: "image/png", messageId: "m1" })
		);
		expect(result.resultText).toContain("image-a-red-fox.png");
		expect(result.resultText).toContain("a red fox in the snow");
		expect(result.resultText).toContain("cannot see images");
		expect(result.images).toBeUndefined();
		expect(result.extraUpdates).toHaveLength(1);
		expect(result.extraUpdates?.[0]).toMatchObject({
			type: MessageUpdateType.CodeExecution,
			subtype: MessageCodeExecutionUpdateType.Outputs,
			files: [
				{
					name: "image-a-red-fox.png",
					prompt: "a red fox",
					revisedPrompt: "a red fox in the snow",
				},
			],
		});
	});

	it("shows the image to a model that sees images, and not once pictures were refused", async () => {
		post.mockResolvedValue(answer(1));
		const seen = await tool({ sees: true }).execute({ prompt: "a red fox" }, ctx());
		if (!("resultText" in seen)) throw new Error("expected a result");
		expect(seen.images).toHaveLength(1);
		expect(seen.images?.[0]).toMatchObject({ mime: "image/png", label: "image-a-red-fox.png" });
		expect(seen.imagesOf).toBe("image-a-red-fox.png");

		const refused = await tool({ sees: true, unavailable: true }).execute(
			{ prompt: "a red fox" },
			ctx()
		);
		if (!("resultText" in refused)) throw new Error("expected a result");
		expect(refused.images).toBeUndefined();
	});

	it("counts images across the calls of a turn, at most four", async () => {
		post.mockImplementation(async (_t, _p, body: { n: number }) => answer(body.n));
		const t = tool();
		expect(await t.execute({ prompt: "one", n: 3 }, ctx())).toHaveProperty("resultText");
		const over = await t.execute({ prompt: "two", n: 2 }, ctx());
		expect(over).toMatchObject({ error: expect.stringContaining("Only 1 more image") });
		expect(await t.execute({ prompt: "three" }, ctx())).toHaveProperty("resultText");
		const full = await t.execute({ prompt: "four" }, ctx());
		expect(full).toMatchObject({ error: expect.stringContaining("limit") });
		expect(post).toHaveBeenCalledTimes(2);
	});

	it("refuses n above four and sizes outside the allowlist before any call", async () => {
		expect(await tool().execute({ prompt: "x", n: 5 }, ctx())).toMatchObject({
			error: expect.stringContaining("At most 4"),
		});
		expect(await tool().execute({ prompt: "x", size: "4000x4000" }, ctx())).toMatchObject({
			error: expect.stringContaining("not supported"),
		});
		expect(await tool().execute({ size: "1024x1024" }, ctx())).toMatchObject({
			error: expect.stringContaining("prompt"),
		});
		expect(post).not.toHaveBeenCalled();
	});

	it("maps an aspect to a size", async () => {
		post.mockResolvedValue(answer(1));
		await tool().execute({ prompt: "x", aspect: "landscape" }, ctx());
		expect(post.mock.calls[0][2]).toMatchObject({ size: "1536x1024", n: 1 });
	});

	it("reports the gateway's message and the refusal of a provider", async () => {
		post.mockRejectedValueOnce(new GatewayCallFailed(403, "model not granted"));
		expect(await tool().execute({ prompt: "x" }, ctx())).toMatchObject({
			error: expect.stringContaining("not available"),
		});
		post.mockRejectedValueOnce(new GatewayCallFailed(503, "provider down"));
		expect(await tool().execute({ prompt: "x" }, ctx())).toMatchObject({
			error: expect.stringContaining("provider down"),
		});
		post.mockRejectedValueOnce(new GatewayCallFailed(400, "rejected by the content filter"));
		expect(await tool().execute({ prompt: "x" }, ctx())).toMatchObject({
			error: expect.stringContaining("refused to draw"),
		});
	});

	it("needs a conversation to keep the file in", async () => {
		expect(await tool().execute({ prompt: "x" }, { uuid: "u", toolCallId: "c" })).toMatchObject({
			error: expect.stringContaining("no conversation"),
		});
	});
});

describe("the approval switch rides on the tool offer", () => {
	it("is offered the same with the switch on (the gate is the invocation's)", () => {
		const conv = { _id: new ObjectId(), plan: undefined, webSearch: undefined };
		for (const askFirst of [true, false]) {
			const names = getEnabledBuiltinTools({
				conv,
				toolsEnabled: true,
				imageGeneration: { model: "m", askFirst },
			}).map((t) => t.name);
			expect(names).toContain(GENERATE_IMAGE_TOOL_NAME);
		}
	});
});
