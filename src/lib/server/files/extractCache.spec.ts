import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const rows = vi.hoisted(
	() => [] as { id: unknown; filename: string; metadata: Record<string, unknown>; body: Buffer }[]
);

vi.mock("$lib/server/database", () => {
	const matches = (row: (typeof rows)[number], filter: Record<string, unknown>) =>
		Object.entries(filter).every(([key, value]) =>
			key.startsWith("metadata.")
				? row.metadata[key.slice(9)] === value
				: (row as unknown as Record<string, unknown>)[key] === value
		);
	return {
		collections: {
			blobStore: {
				find: async (_b: string, f: Record<string, unknown>) => rows.filter((r) => matches(r, f)),
				findOne: async (_b: string, f: Record<string, unknown>) =>
					rows.find((r) => matches(r, f)) ?? null,
				read: async (_b: string, id: unknown) => rows.find((r) => r.id === id)?.body,
				put: async (
					_b: string,
					o: { filename: string; metadata: Record<string, unknown> },
					body: Buffer
				) => {
					rows.push({ id: new ObjectId(), filename: o.filename, metadata: o.metadata, body });
				},
			},
		},
	};
});

const { getCachedExtraction, putCachedExtraction } = await import("./extractCache");
const conv = new ObjectId().toString();

beforeEach(() => {
	rows.length = 0;
});

describe("the extraction cache", () => {
	it("keeps each read as one entry tagged with the conversation, and merges them on read", async () => {
		await putCachedExtraction(conv, "sha", "ocr", { pages: { 1: "one", 2: "two" }, total: 9 });
		await putCachedExtraction(conv, "sha", "ocr", { pages: { 5: "five" } });
		const merged = await getCachedExtraction(conv, "sha", "ocr");
		expect([...(merged?.pages ?? [])]).toEqual([
			[1, "one"],
			[2, "two"],
			[5, "five"],
		]);
		expect(merged?.total).toBe(9);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.metadata.conversation === conv)).toBe(true);
	});

	it("writes the same read once, and keys on the bytes, the reader and the conversation", async () => {
		await putCachedExtraction(conv, "sha", "ocr", { text: "all" });
		await putCachedExtraction(conv, "sha", "ocr", { text: "all" });
		expect(rows).toHaveLength(1);
		expect((await getCachedExtraction(conv, "sha", "ocr"))?.text).toBe("all");
		expect(await getCachedExtraction(conv, "sha", "other-reader")).toBeNull();
		expect(await getCachedExtraction(conv, "other-bytes", "ocr")).toBeNull();
		expect(await getCachedExtraction(new ObjectId().toString(), "sha", "ocr")).toBeNull();
	});

	it("names entries so that no file route, which looks up <conversation>-<hash>, can reach one", async () => {
		await putCachedExtraction(conv, "sha", "ocr", { text: "all" });
		expect(rows[0].filename).toMatch(/^extract:[0-9a-f]{24}:[0-9a-f]{64}$/);
		expect(rows[0].filename.startsWith(`${conv}-`)).toBe(false);
	});
});
