import { describe, expect, it } from "vitest";

// Guard for vite.config.ts `clientTestNoApiServer`: a request a client test leaves unstubbed must
// not reach the real app (it hangs under CI load and starves the suite's module loads).
describe("the client tests' dev server", () => {
	it("answers an unstubbed /api request with a 404 at once", async () => {
		const started = performance.now();
		const res = await fetch("/api/v2/never-stubbed");
		expect(res.status).toBe(404);
		expect(performance.now() - started).toBeLessThan(2000);
	});

	it("answers an <img> pointing at /api with an error at once", async () => {
		const img = new Image();
		const settled = new Promise<string>((resolve) => {
			img.onload = () => resolve("load");
			img.onerror = () => resolve("error");
		});
		img.src = "/api/v2/never-stubbed.png";
		expect(await settled).toBe("error");
	});
});
