import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const { post, get, contentFetch, store, state } = vi.hoisted(() => ({
	post: vi.fn(),
	get: vi.fn(),
	contentFetch: vi.fn(),
	store: vi.fn(),
	state: { stored: null as string | null, askFirst: undefined as boolean | undefined, env: "" },
}));

vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/server/config", () => ({
	config: new Proxy(
		{},
		{
			get(_t, key: string) {
				if (key === "CHAT_IMAGE_MODEL") return state.env;
				if (key === "OPENAI_BASE_URL") return "http://gw";
				return undefined;
			},
		}
	),
}));
vi.mock("$lib/server/database", () => ({
	collections: {
		imageConfig: {
			findOne: vi.fn(async () =>
				state.stored || state.askFirst !== undefined
					? { model: state.stored, askFirst: state.askFirst }
					: null
			),
		},
	},
}));
vi.mock("$lib/server/execution/deliverables", () => ({ storeDeliverable: store }));
vi.mock("$lib/server/urlSafety", () => ({ contentFetch }));
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
		constructor(..._args: number[]) {
			super(504, "timeout");
		}
	}
	return { gateway: { get, post }, GatewayCallFailed, GatewayTimeout };
});

import { GatewayCallFailed, GatewayTimeout } from "$lib/server/gatewayServer";
import {
	MAX_IMAGE_BYTES,
	clearImageModelCache,
	generateImages,
	imageAskFirst,
	imageDimensions,
	imageFileStem,
	imageResultText,
	parseImageArgs,
	resolveImage,
	resolveImageModel,
	sniffImage,
} from "./imageGeneration";

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]);
const b64 = (bytes: Buffer) => bytes.toString("base64");

beforeEach(() => {
	vi.clearAllMocks();
	clearImageModelCache();
	state.stored = null;
	state.env = "";
	state.askFirst = undefined;
	get.mockResolvedValue({
		data: [
			{ id: "chat-1", kind: "chat" },
			{ id: "flux-2-klein-4b", kind: "image" },
			{ id: "z-image-turbo", kind: "image" },
		],
	});
	store.mockImplementation(async (input: { name: string; bytes: Buffer }) => ({
		ok: true,
		ref: { name: input.name, size: input.bytes.byteLength, sha256: "a".repeat(64) },
	}));
});

describe("image model resolution", () => {
	it("is the admin's choice, then the environment, then the first model", () => {
		const candidates = ["a", "b"];
		expect(resolveImage({ storedModel: "s", envModel: "e", candidates }).source).toBe("stored");
		expect(resolveImage({ storedModel: null, envModel: "e", candidates }).source).toBe("env");
		expect(resolveImage({ storedModel: null, envModel: null, candidates })).toEqual({
			model: "a",
			source: "first-available",
		});
		expect(resolveImage({ storedModel: null, envModel: null, candidates: [] })).toEqual({
			model: null,
			source: "none",
		});
	});

	it("reads kind: image from the user's catalogue, with a short deadline", async () => {
		expect(await resolveImageModel("tok")).toEqual({
			model: "flux-2-klein-4b",
			source: "first-available",
		});
		expect(get).toHaveBeenCalledWith("tok", "models?include=image", { timeoutMs: 2000 });
	});

	it("prefers the admin's choice over the environment", async () => {
		state.stored = "z-image-turbo";
		state.env = "flux-2-klein-4b";
		expect(await resolveImageModel("tok")).toEqual({ model: "z-image-turbo", source: "stored" });
		state.stored = null;
		clearImageModelCache();
		expect(await resolveImageModel("tok")).toEqual({ model: "flux-2-klein-4b", source: "env" });
	});

	it("does not offer a named model this user may not use", async () => {
		state.env = "qwen-image-2512";
		expect(await resolveImageModel("tok")).toEqual({ model: null, source: "none" });
	});

	it("fails closed when the catalogue is slow, down, or has no image model", async () => {
		get.mockRejectedValueOnce(new GatewayTimeout(2000, 2000));
		expect(await resolveImageModel("slow")).toEqual({ model: null, source: "none" });
		state.env = "flux-2-klein-4b";
		clearImageModelCache();
		get.mockRejectedValueOnce(new Error("down"));
		expect((await resolveImageModel("down")).model).toBeNull();
		clearImageModelCache();
		get.mockResolvedValueOnce({ data: [{ id: "chat-1", kind: "chat" }] });
		state.env = "";
		expect((await resolveImageModel("none")).model).toBeNull();
	});

	it("asks the catalogue once for a burst", async () => {
		await Promise.all([resolveImageModel("b"), resolveImageModel("b"), resolveImageModel("b")]);
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("reads the approval switch, off by default and closed when unreadable", async () => {
		expect(await imageAskFirst()).toBe(false);
		state.askFirst = true;
		expect(await imageAskFirst()).toBe(true);
	});
});

describe("parseImageArgs", () => {
	it("defaults to one 1024 square", () => {
		expect(parseImageArgs({ prompt: "  a fox " })).toEqual({
			ok: true,
			prompt: "a fox",
			size: "1024x1024",
			n: 1,
		});
	});

	it("maps an aspect to a size, and a size wins over it", () => {
		expect(parseImageArgs({ prompt: "x", aspect: "landscape" })).toMatchObject({
			size: "1344x768",
		});
		expect(parseImageArgs({ prompt: "x", aspect: "portrait" })).toMatchObject({
			size: "768x1344",
		});
		expect(parseImageArgs({ prompt: "x", size: "768x1344", aspect: "landscape" })).toMatchObject({
			size: "768x1344",
		});
	});

	it("refuses sizes outside the allowlist, bad aspects, bad n, and empty prompts", () => {
		expect(parseImageArgs({ prompt: "x", size: "99999x99999" })).toMatchObject({
			ok: false,
			error: expect.stringContaining("not supported"),
		});
		expect(parseImageArgs({ prompt: "x", aspect: "wide" })).toMatchObject({ ok: false });
		expect(parseImageArgs({ prompt: "x", n: 5 })).toMatchObject({
			ok: false,
			error: expect.stringContaining("At most 4"),
		});
		expect(parseImageArgs({ prompt: "x", n: 0 })).toMatchObject({ ok: false });
		expect(parseImageArgs({ prompt: "x", n: 1.5 })).toMatchObject({ ok: false });
		expect(parseImageArgs({ prompt: "   " })).toMatchObject({ ok: false });
		expect(parseImageArgs({ prompt: "x".repeat(5000) })).toMatchObject({ ok: false });
		expect(parseImageArgs({ prompt: "x", n: "3" })).toMatchObject({ ok: true, n: 3 });
	});
});

describe("file names and formats", () => {
	it("makes a short ascii name from the prompt", () => {
		expect(imageFileStem("A red fox, in the snow!")).toBe("image-a-red-fox-in-the-snow");
		expect(imageFileStem("Café société")).toBe("image-cafe-societe");
		expect(imageFileStem("???")).toBe("image-generated");
		expect(imageFileStem("x".repeat(100)).length).toBeLessThanOrEqual(46);
	});

	it("knows raster formats by their bytes, and nothing else", () => {
		expect(sniffImage(PNG)?.ext).toBe("png");
		expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))?.ext).toBe("jpg");
		expect(sniffImage(Buffer.from("RIFF1234WEBPVP8 "))?.ext).toBe("webp");
		expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
	});
});

describe("delivered dimensions", () => {
	it("reads them from the PNG and JPEG headers, not from the request", () => {
		const png = Buffer.alloc(33);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
		png.write("IHDR", 12);
		png.writeUInt32BE(1024, 16);
		png.writeUInt32BE(768, 20);
		expect(imageDimensions(png)).toEqual({ width: 1024, height: 768 });
		// SOI, an APP0 segment of length 4, then SOF0 (height 768, width 1024).
		const jpeg = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x00,
			0x04, 0x00, 0x03, 0x01, 0x11, 0x00,
		]);
		expect(imageDimensions(jpeg)).toEqual({ width: 1024, height: 768 });
		expect(imageDimensions(Buffer.from("nope"))).toBeNull();
	});

	it("stores and names a JPEG answer by its real format and reports its size", async () => {
		const jpeg = Buffer.from([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x03, 0x00,
			0x04, 0x00, 0x03, 0x01, 0x11, 0x00,
		]);
		post.mockResolvedValue({
			data: [{ b64_json: jpeg.toString("base64"), revised_prompt: null, url: null }],
		});
		const result = await generateImages({
			token: "tok",
			prompt: "a fox",
			size: "1344x768",
			n: 1,
			conversationId: new ObjectId(),
		});
		if (!result.ok) throw new Error("expected ok");
		expect(result.files[0]).toMatchObject({ width: 1024, height: 768, mime: "image/jpeg" });
		expect(result.files[0].ref.name).toBe("image-a-fox.jpg");
		expect(result.files[0].ref.revisedPrompt).toBeUndefined();
		expect(imageResultText(result, false)).toContain("1024x768 px");
	});
});

describe("generateImages", () => {
	const base = {
		token: "tok",
		prompt: "a red fox",
		size: "1024x1024" as const,
		n: 1,
		conversationId: new ObjectId(),
		userId: new ObjectId(),
		messageId: "m1",
	};

	it("sends the gateway's request as the user, asks for b64_json, and stores the result", async () => {
		post.mockResolvedValue({ data: [{ b64_json: b64(PNG), revised_prompt: "a red fox in snow" }] });
		const result = await generateImages({ ...base, billHeaders: { "x-bill-to": "org" } });
		expect(post).toHaveBeenCalledWith(
			"tok",
			"images/generations",
			{
				model: "flux-2-klein-4b",
				prompt: "a red fox",
				n: 1,
				size: "1024x1024",
				response_format: "b64_json",
			},
			expect.objectContaining({ headers: { "x-bill-to": "org" }, timeoutMs: 120_000 })
		);
		expect(store).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "image-a-red-fox.png",
				mime: "image/png",
				tool: "generate_image",
				messageId: "m1",
			})
		);
		expect(result).toMatchObject({ ok: true, model: "flux-2-klein-4b" });
		if (!result.ok) throw new Error("unreachable");
		expect(result.files[0].ref).toMatchObject({
			name: "image-a-red-fox.png",
			prompt: "a red fox",
			revisedPrompt: "a red fox in snow",
		});
	});

	it("numbers several images", async () => {
		post.mockResolvedValue({ data: [{ b64_json: b64(PNG) }, { b64_json: b64(PNG) }] });
		const result = await generateImages({ ...base, n: 2 });
		if (!result.ok) throw new Error("expected ok");
		expect(result.files.map((f) => f.ref.name)).toEqual([
			"image-a-red-fox-1.png",
			"image-a-red-fox-2.png",
		]);
	});

	it("follows a returned URL through the content guard, with a size cap", async () => {
		post.mockResolvedValue({ data: [{ url: "https://cdn.example/a.png" }] });
		contentFetch.mockResolvedValue(new Response(PNG, { status: 200 }));
		const result = await generateImages(base);
		expect(contentFetch).toHaveBeenCalledTimes(1);
		expect(String(contentFetch.mock.calls[0][0])).toBe("https://cdn.example/a.png");
		expect(result.ok).toBe(true);

		contentFetch.mockResolvedValue(
			new Response("x", { status: 200, headers: { "content-length": String(MAX_IMAGE_BYTES + 1) } })
		);
		const big = await generateImages(base);
		expect(big).toMatchObject({ ok: false, error: expect.stringContaining("size limit") });
	});

	it("drops a URL the guard refuses and anything that is not an image", async () => {
		post.mockResolvedValue({ data: [{ url: "http://127.0.0.1/secret.png" }] });
		contentFetch.mockRejectedValue(new Error("unsafe IP (SSRF)"));
		const refused = await generateImages(base);
		expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("safely") });
		expect(store).not.toHaveBeenCalled();

		post.mockResolvedValue({ data: [{ b64_json: b64(Buffer.from("<svg/>")) }] });
		const notImage = await generateImages(base);
		expect(notImage).toMatchObject({ ok: false, error: expect.stringContaining("not a PNG") });
		expect(store).not.toHaveBeenCalled();
	});

	it("says what is wrong for each gateway failure", async () => {
		const failWith = async (err: unknown) => {
			post.mockRejectedValueOnce(err);
			const result = await generateImages(base);
			if (result.ok) throw new Error("expected failure");
			return result.error;
		};
		expect(await failWith(new GatewayCallFailed(403, "no grant"))).toContain("not available");
		const quota = await failWith(
			new GatewayCallFailed(
				429,
				"Quota exceeded. user limit of 1 cost per month exceeded",
				"quota_exceeded"
			)
		);
		expect(quota).toContain("quota");
		expect(quota).toContain("Do not retry");
		expect(quota).not.toContain("rate limited");
		expect(await failWith(new GatewayCallFailed(429, "slow"))).toContain("rate limited");
		expect(await failWith(new GatewayCallFailed(502, "upstream broke"))).toContain(
			"upstream broke"
		);
		expect(await failWith(new GatewayCallFailed(400, "Prompt violates content policy"))).toContain(
			"refused to draw"
		);
		expect(await failWith(new GatewayCallFailed(422, "size not supported by model"))).toContain(
			"size not supported by model"
		);
		expect(await failWith(new GatewayTimeout(2000, 2000))).toContain("took too long");
		expect(await failWith(new Error("ECONNREFUSED"))).toContain("could not be reached");
	});

	it("retries once at 1024x1024 when the model only makes that size, and says so", async () => {
		post
			.mockRejectedValueOnce(
				new GatewayCallFailed(400, "Only 1024x1024 size is currently supported")
			)
			.mockResolvedValueOnce({ data: [{ b64_json: b64(PNG) }] });
		const result = await generateImages({ ...base, size: "1344x768" });
		expect(post).toHaveBeenCalledTimes(2);
		expect(post.mock.calls[1][2]).toMatchObject({ size: "1024x1024" });
		if (!result.ok) throw new Error("expected ok");
		expect(result.size).toBe("1024x1024");
		expect(imageResultText(result, false)).toContain(
			"This model only makes 1024x1024 images; made a square one instead."
		);
	});

	it("does not retry a size error at 1024x1024, a second failure, or other 400s", async () => {
		post.mockRejectedValueOnce(new GatewayCallFailed(400, "size not supported"));
		expect(await generateImages({ ...base, size: "1024x1024" })).toMatchObject({ ok: false });
		expect(post).toHaveBeenCalledTimes(1);

		post.mockReset();
		post
			.mockRejectedValueOnce(new GatewayCallFailed(400, "bad size"))
			.mockRejectedValueOnce(new GatewayCallFailed(400, "bad size"));
		expect(await generateImages({ ...base, size: "768x1344" })).toMatchObject({ ok: false });
		expect(post).toHaveBeenCalledTimes(2);

		post.mockReset();
		post.mockRejectedValueOnce(new GatewayCallFailed(400, "prompt too long"));
		await generateImages({ ...base, size: "768x1344" });
		expect(post).toHaveBeenCalledTimes(1);
	});

	it("refuses with no credential and with no model, before any call", async () => {
		expect(await generateImages({ ...base, token: undefined })).toMatchObject({ ok: false });
		get.mockResolvedValue({ data: [] });
		clearImageModelCache();
		const none = await generateImages({ ...base, model: undefined });
		expect(none).toMatchObject({ ok: false, error: expect.stringContaining("No image model") });
		expect(post).not.toHaveBeenCalled();
	});

	it("reports a conversation that is full of files", async () => {
		post.mockResolvedValue({ data: [{ b64_json: b64(PNG) }] });
		store.mockResolvedValue({ ok: false, status: 413, error: "This conversation is full." });
		expect(await generateImages(base)).toMatchObject({
			ok: false,
			error: expect.stringContaining("This conversation is full."),
		});
	});
});
