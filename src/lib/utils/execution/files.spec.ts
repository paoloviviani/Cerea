import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchWithinCap } from "./files";

/**
 * Node's undici implements Response with body streams, so the cap logic runs
 * here for real — both the Content-Length fast path and the streaming stop.
 */
describe("fetchWithinCap", () => {
	const server = "http://runtime.test";

	afterEach(() => vi.unstubAllGlobals());

	it("returns the body when Content-Length is within the cap", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("a,b\n1,2\n", {
						headers: { "Content-Length": String("a,b\n1,2\n".length) },
					})
			)
		);
		const bytes = await fetchWithinCap(`${server}/file.csv`, 1024);
		expect(new TextDecoder().decode(bytes)).toBe("a,b\n1,2\n");
	});

	it("refuses a declared size over the cap before reading the body", async () => {
		let bodyPulled = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							pull() {
								bodyPulled = true;
							},
							start(controller) {
								controller.enqueue(new Uint8Array([1]));
							},
						}),
						{ headers: { "Content-Length": String(3 * 1024 * 1024) } }
					)
			)
		);
		await expect(fetchWithinCap(`${server}/big.csv`, 1024)).rejects.toThrow(
			/the runtime accepts files up to 50 MB/
		);
		// The refusal happened on the declared length; the body was never read.
		expect(bodyPulled).toBe(false);
	});

	it("stops a missing-Content-Length stream the moment it passes the cap", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array(900));
								controller.enqueue(new Uint8Array(900));
								controller.close();
							},
						})
					)
			)
		);
		await expect(fetchWithinCap(`${server}/trickle.bin`, 1024)).rejects.toThrow(
			/accepts files up to 50 MB/
		);
	});

	it("surfaces the endpoint's own error message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: { message: '"report" has no indexed text yet' } }), {
						status: 409,
					})
			)
		);
		await expect(fetchWithinCap(`${server}/content`)).rejects.toThrow(/no indexed text yet/);
	});
});
