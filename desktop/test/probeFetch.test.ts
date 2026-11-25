import { describe, expect, it } from "vitest";
import { cappedFetch, iconFetcher, readCapped, TooLarge } from "../src/main/probeFetch.ts";

const stream = (chunks: Uint8Array[]) =>
	new ReadableStream<Uint8Array>({
		start(c) {
			for (const x of chunks) c.enqueue(x);
			c.close();
		},
	});
const res = (status: number, body: Uint8Array[], type = "application/json") => ({
	status,
	headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? type : null) },
	body: stream(body),
});

describe("bounded reads", () => {
	it("stops at the cap instead of buffering what a server sends", async () => {
		await expect(readCapped(stream([new Uint8Array(40), new Uint8Array(40)]), 64)).rejects.toThrow(
			TooLarge
		);
		expect((await readCapped(stream([new Uint8Array(10)]), 64)).byteLength).toBe(10);
	});

	it("the probe's text() is capped at 64 KB", async () => {
		const f = cappedFetch(async () => res(200, [new Uint8Array(70_000)]));
		const r = await f("https://x", { signal: new AbortController().signal, redirect: "manual" });
		await expect(r.text()).rejects.toThrow(TooLarge);
	});

	it("an icon is a small raster image or nothing", async () => {
		const png = new Uint8Array([137, 80, 78, 71]);
		expect(await iconFetcher(async () => res(200, [png], "image/png"))("https://x/i.png")).toMatch(
			/^data:image\/png;base64,/
		);
		expect(
			await iconFetcher(async () => res(200, [png], "image/svg+xml"))("https://x/i.svg")
		).toBeUndefined();
		expect(
			await iconFetcher(async () => res(302, [png], "image/png"))("https://x/i.png")
		).toBeUndefined();
		expect(
			await iconFetcher(async () => res(200, [new Uint8Array(300 * 1024)], "image/png"))(
				"https://x/i.png"
			)
		).toBeUndefined();
	});
});
