import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import sharp from "sharp";

const files = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock("./conversationFiles", async (importOriginal) => ({
	...(await importOriginal<typeof import("./conversationFiles")>()),
	findConversationFile: files.find,
	branchOfCall: async () => undefined,
}));
vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createViewImageBuiltin, parseCrop, MAX_VIEW_CALLS_PER_TURN } =
	await import("./viewImageTool");

const ctx = () => ({ uuid: "u", toolCallId: "c", conversationId: new ObjectId() });

/** Left half red, right half blue; stored sideways when `orientation` is 6, so upright it is portrait. */
async function image(width: number, height: number, orientation?: number): Promise<Buffer> {
	const raw = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const o = (y * width + x) * 3;
			raw[o] = x < width / 2 ? 255 : 0;
			raw[o + 2] = x < width / 2 ? 0 : 255;
		}
	}
	let inst = sharp(raw, { raw: { width, height, channels: 3 } });
	if (orientation) inst = inst.withMetadata({ orientation });
	return inst.jpeg({ quality: 95 }).toBuffer();
}

function found(bytes: Buffer, name = "photo.jpg") {
	return { ok: true, name, bytes, sha256: "x", mime: "image/jpeg", origin: "attachment" };
}

const [tool] = createViewImageBuiltin();

async function run(args: Record<string, unknown>) {
	const result = await createViewImageBuiltin()[0].execute(args, ctx());
	return result;
}

async function shownSize(result: Awaited<ReturnType<typeof run>>) {
	if (!("images" in result) || !result.images?.length) throw new Error(JSON.stringify(result));
	const meta = await sharp(Buffer.from(result.images[0].base64, "base64")).metadata();
	return { width: meta.width, height: meta.height, mime: result.images[0].mime };
}

beforeEach(() => files.find.mockReset());

describe("view_image", () => {
	it("is a function tool named view_image taking a file, an optional crop and rotate", () => {
		expect(tool.name).toBe("view_image");
		const params = tool.definition.function.parameters as {
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(Object.keys(params.properties)).toEqual(["file", "crop", "crop_unit", "rotate"]);
		expect(params.required).toEqual(["file"]);
	});

	it("returns a crop as an image part with the right dimensions", async () => {
		files.find.mockResolvedValue(found(await image(800, 600)));
		const result = await run({
			file: "/mnt/data/photo.jpg",
			crop: { x: 100, y: 50, width: 300, height: 200 },
		});
		expect(await shownSize(result)).toEqual({ width: 300, height: 200, mime: "image/png" });
		expect(files.find.mock.calls[0][1]).toBe("photo.jpg");
		expect(files.find.mock.calls[0][2]).toMatchObject({ source: "mounted" });
	});

	it("reads /mnt/output as a produced file", async () => {
		files.find.mockResolvedValue(found(await image(100, 100), "chart.png"));
		await run({ file: "/mnt/output/chart.png" });
		expect(files.find.mock.calls[0][1]).toBe("chart.png");
		expect(files.find.mock.calls[0][2]).toMatchObject({ source: "output" });
	});

	it("takes the crop in the upright picture: an EXIF-sideways photo is cropped as the model sees it", async () => {
		// Stored 800x600, tagged 6: upright it is 600x800, red half on top, blue half below.
		files.find.mockResolvedValue(found(await image(800, 600, 6)));
		const result = await run({
			file: "photo.jpg",
			crop: { x: 0, y: 500, width: 600, height: 300 },
		});
		expect(await shownSize(result)).toMatchObject({ width: 600, height: 300 });
		if (!("images" in result) || !result.images) throw new Error("no image");
		const { data } = await sharp(Buffer.from(result.images[0].base64, "base64"))
			.raw()
			.toBuffer({ resolveWithObject: true });
		expect(data[2]).toBeGreaterThan(200); // blue: the bottom half of the upright picture
	});

	it("takes fractions, and turns the result", async () => {
		files.find.mockResolvedValue(found(await image(800, 400)));
		const result = await run({
			file: "photo.jpg",
			crop: { x: 0, y: 0, width: 0.5, height: 1 },
			crop_unit: "fraction",
			rotate: 90,
		});
		expect(await shownSize(result)).toMatchObject({ width: 400, height: 400 });
		const wide = await run({
			file: "photo.jpg",
			crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
			crop_unit: "fraction",
			rotate: 90,
		});
		expect(await shownSize(wide)).toMatchObject({ width: 200, height: 400 });
	});

	it("cuts a box that runs past the edge, and refuses one outside it, naming the size", async () => {
		files.find.mockResolvedValue(found(await image(200, 100)));
		const cut = await run({ file: "photo.jpg", crop: { x: 150, y: 50, width: 500, height: 500 } });
		expect(await shownSize(cut)).toMatchObject({ width: 50, height: 50 });
		const outside = await run({ file: "photo.jpg", crop: { x: 900, y: 0, width: 10, height: 10 } });
		expect(outside).toMatchObject({ error: expect.stringContaining("200 x 100") });
	});

	it("passes the whole picture through when there is no crop or rotation", async () => {
		const bytes = await image(300, 200);
		files.find.mockResolvedValue(found(bytes));
		const result = await run({ file: "photo.jpg" });
		if (!("images" in result) || !result.images) throw new Error("no image");
		expect(Buffer.from(result.images[0].base64, "base64").equals(bytes)).toBe(true);
		expect(result).toMatchObject({ resultText: expect.stringContaining("300 x 200") });
	});

	it("refuses a file the conversation withholds or does not have, with the lookup's own words", async () => {
		files.find.mockResolvedValue({ ok: false, error: "A privacy rule withheld this attachment." });
		expect(await run({ file: "/mnt/data/secret.jpg" })).toEqual({
			error: "A privacy rule withheld this attachment.",
		});
		files.find.mockResolvedValue({
			ok: false,
			error: 'No file named "nope.png" in this conversation.',
		});
		expect(await run({ file: "nope.png" })).toMatchObject({
			error: expect.stringContaining("nope.png"),
		});
	});

	it("refuses paths outside the conversation and files that are not images", async () => {
		expect(await run({ file: "/etc/passwd" })).toMatchObject({
			error: expect.stringContaining("/mnt/data"),
		});
		expect(await run({ file: "/mnt/data/../x.png" })).toMatchObject({
			error: expect.stringContaining("not a valid"),
		});
		files.find.mockResolvedValue(found(Buffer.from("%PDF-1.7"), "scan.pdf"));
		expect(await run({ file: "scan.pdf" })).toMatchObject({
			error: expect.stringContaining("look_doc"),
		});
	});

	it("stops after its per-turn call limit", async () => {
		files.find.mockResolvedValue(found(await image(100, 100)));
		const turn = createViewImageBuiltin()[0];
		for (let i = 0; i < MAX_VIEW_CALLS_PER_TURN; i += 1) {
			await turn.execute({ file: "photo.jpg", crop: { x: 0, y: 0, width: 50, height: 50 } }, ctx());
		}
		expect(await turn.execute({ file: "photo.jpg" }, ctx())).toMatchObject({
			error: expect.stringContaining("limit"),
		});
	});

	it("answers once the endpoint has refused pictures this turn", async () => {
		const state = { unavailable: true };
		const [t] = createViewImageBuiltin(state);
		expect(await t.execute({ file: "photo.jpg" }, ctx())).toMatchObject({
			error: expect.stringContaining("not available"),
		});
	});
});

describe("parseCrop", () => {
	it("is absent when not given", () => {
		expect(parseCrop({}, { width: 10, height: 10 })).toEqual({ ok: true, box: undefined });
	});
});
