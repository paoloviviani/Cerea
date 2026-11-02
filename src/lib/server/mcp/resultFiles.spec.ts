import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { pdfBytes, realPng, tinyXlsx } from "./resultFilesFixtures";
import { saveResultFiles, safeFileName, MIN_BASE64_CHARS } from "./resultFiles";
import type { storeDeliverable } from "$lib/server/execution/deliverables";

vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const conversationId = new ObjectId();

function fakeStore() {
	const calls: Array<Parameters<typeof storeDeliverable>[0]> = [];
	const store = vi.fn(async (input: Parameters<typeof storeDeliverable>[0]) => {
		calls.push(input);
		return {
			ok: true as const,
			ref: { name: input.name, size: input.bytes.byteLength, sha256: "x".repeat(64) },
		};
	}) as unknown as typeof storeDeliverable;
	return { store, calls };
}

const ctx = (store: typeof storeDeliverable, args?: Record<string, unknown>) => ({
	conversationId,
	tool: "download_bytes",
	store,
	...(args ? { args } : {}),
});

describe("saveResultFiles", () => {
	it("keeps the other fields of a JSON result and replaces the base64 with a note", async () => {
		const xlsx = tinyXlsx();
		const b64 = xlsx.toString("base64");
		expect(b64.length).toBeGreaterThan(MIN_BASE64_CHARS);
		const { store, calls } = fakeStore();
		const out = await saveResultFiles(
			{
				text: JSON.stringify({
					name: "ore_guardia.xlsx",
					size: xlsx.length,
					contentType: "x",
					value: b64,
				}),
			},
			ctx(store)
		);
		const parsed = JSON.parse(out.text);
		expect(parsed.name).toBe("ore_guardia.xlsx");
		expect(parsed.size).toBe(xlsx.length);
		expect(parsed.value).toMatch(
			/^\[file saved to this conversation: ore_guardia\.xlsx \(\d+\.\d KB, Excel\); open it with doc_read\/look_doc or at \/mnt\/data\/ore_guardia\.xlsx in code\]$/
		);
		expect(out.text).not.toContain(b64.slice(0, 60));
		expect(calls).toHaveLength(1);
		expect(calls[0].mime).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
		expect(Buffer.compare(calls[0].bytes, xlsx)).toBe(0);
		expect(out.refs.map((r) => r.name)).toEqual(["ore_guardia.xlsx"]);
	});

	it("finds pdf and png by signature, in structured content, and stores the file once", async () => {
		const pdf = pdfBytes().toString("base64");
		const png = realPng().toString("base64");
		const { store, calls } = fakeStore();
		const out = await saveResultFiles(
			{
				text: JSON.stringify({ filename: "a.pdf", data: pdf }),
				structured: { filename: "a.pdf", data: pdf, nested: [{ title: "pic", image: png }] },
				content: [{ type: "text", text: JSON.stringify({ filename: "a.pdf", data: pdf }) }],
			},
			ctx(store)
		);
		expect(calls.map((c) => c.name)).toEqual(["a.pdf", "pic.png"]);
		expect(JSON.stringify(out)).not.toContain(pdf.slice(0, 80));
		expect(JSON.stringify(out)).not.toContain(png.slice(0, 80));
		expect(JSON.stringify(out.content)).toContain("file saved to this conversation: a.pdf");
		expect(out.refs).toHaveLength(2);
	});

	it("leaves base64-looking text without a file signature alone", async () => {
		const b64 = Buffer.from("just some words ".repeat(200)).toString("base64");
		const { store, calls } = fakeStore();
		const text = JSON.stringify({ blob: b64 });
		const out = await saveResultFiles({ text, structured: { blob: b64 } }, ctx(store));
		expect(out.text).toBe(text);
		expect(out.structured).toEqual({ blob: b64 });
		expect(calls).toHaveLength(0);
	});

	it("leaves a short value with a signature alone", async () => {
		const { store, calls } = fakeStore();
		const text = JSON.stringify({ v: realPng(8).toString("base64") });
		const out = await saveResultFiles({ text }, ctx(store));
		expect(out.text).toBe(text);
		expect(calls).toHaveLength(0);
	});

	it("names a file from the call's arguments, then file-<n>", async () => {
		const png = realPng().toString("base64");
		const { store, calls } = fakeStore();
		await saveResultFiles(
			{ text: JSON.stringify({ data: png }) },
			ctx(store, { fileName: "chart" })
		);
		expect(calls[0].name).toBe("chart.png");
		const second = fakeStore();
		const out = await saveResultFiles(
			{ text: JSON.stringify({ a: png, b: pdfBytes().toString("base64") }) },
			ctx(second.store)
		);
		expect(second.calls.map((c) => c.name)).toEqual(["file-1.png", "file-2.pdf"]);
		expect(out.text).toContain("/mnt/data/file-2.pdf");
	});

	it("saves a resource blob under its uri's name and the block without the blob", async () => {
		const bytes = Buffer.from("a,b\n1,2\n");
		const { store, calls } = fakeStore();
		const out = await saveResultFiles(
			{
				text: "",
				content: [
					{
						type: "resource",
						resource: {
							uri: "file:///drive/items/Q3%20numbers.csv",
							mimeType: "text/csv",
							blob: bytes.toString("base64"),
						},
					},
				],
			},
			ctx(store)
		);
		expect(calls[0].name).toBe("Q3 numbers.csv");
		expect(calls[0].mime).toBe("text/csv");
		expect(out.text).toContain("[file saved to this conversation: Q3 numbers.csv");
		expect(JSON.stringify(out.content)).not.toContain(bytes.toString("base64"));
		expect(JSON.stringify(out.content)).not.toContain('"blob"');
	});

	it("saves image and audio content as files with a note", async () => {
		const { store, calls } = fakeStore();
		const out = await saveResultFiles(
			{
				text: "done",
				content: [
					{ type: "text", text: "done" },
					{ type: "image", data: realPng(8).toString("base64"), mimeType: "image/png" },
					{
						type: "audio",
						data: Buffer.from("RIFFxxxxWAVE").toString("base64"),
						mimeType: "audio/wav",
					},
				],
			},
			ctx(store)
		);
		expect(calls.map((c) => c.name)).toEqual(["image-1.png", "audio-2.wav"]);
		expect(out.text.startsWith("done\n[file saved")).toBe(true);
		expect(JSON.stringify(out.content)).not.toContain("iVBOR");
	});

	it("does not store a file over the cap and says so", async () => {
		const { store, calls } = fakeStore();
		const head = pdfBytes().toString("base64").slice(0, 24);
		const huge = head + "A".repeat(70 * 1024 * 1024);
		const out = await saveResultFiles({ text: JSON.stringify({ data: huge }) }, ctx(store));
		expect(calls).toHaveLength(0);
		expect(out.text).toMatch(/larger than the 50 MB limit, so it was not saved/);
		expect(out.text.length).toBeLessThan(400);
	});

	it("falls back to a note when storing fails, without the base64", async () => {
		const png = realPng().toString("base64");
		const refused = vi.fn(async () => ({
			ok: false as const,
			status: 413 as const,
			error: "limit reached",
		})) as unknown as typeof storeDeliverable;
		const out = await saveResultFiles({ text: JSON.stringify({ data: png }) }, ctx(refused));
		expect(out.text).toContain("a file was returned but could not be saved: limit reached");
		expect(out.text).not.toContain(png.slice(0, 40));
		const thrown = vi.fn(async () => {
			throw new Error("mongo down");
		}) as unknown as typeof storeDeliverable;
		const out2 = await saveResultFiles({ text: JSON.stringify({ data: png }) }, ctx(thrown));
		expect(out2.text).toContain("could not be saved");
		expect(out2.text).not.toContain(png.slice(0, 40));
	});

	it("has no conversation to keep a file in: a note, no bytes", async () => {
		const png = realPng().toString("base64");
		const out = await saveResultFiles({ text: png }, { tool: "t" });
		expect(out.text).toContain("could not be saved");
		expect(out.text).not.toContain(png.slice(0, 40));
	});
});

describe("safeFileName", () => {
	it("keeps the last segment, drops control characters and leading dots", () => {
		expect(safeFileName("../../etc/passwd")).toBe("passwd");
		expect(safeFileName("..\\..\\win\\a.xlsx")).toBe("a.xlsx");
		expect(safeFileName(".hidden\u0000.pdf")).toBe("hidden.pdf");
		expect(safeFileName("../")).toBe("");
		expect(safeFileName(`${"x".repeat(300)}.pdf`)).toHaveLength(104);
	});
});
