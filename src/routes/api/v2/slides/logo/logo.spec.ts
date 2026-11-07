import { describe, it, expect, vi, beforeEach } from "vitest";

const defaults = vi.hoisted(() => ({ value: {} as { logo?: string } }));
vi.mock("$lib/server/slideDefaults", () => ({ slideDefaults: () => defaults.value }));

import { GET } from "./+server";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

const call = (locals: object, headers: Record<string, string> = {}) =>
	GET({ locals, request: new Request("http://x/api/v2/slides/logo", { headers }) } as never);

beforeEach(() => {
	defaults.value = {};
});

describe("GET /api/v2/slides/logo", () => {
	it("needs a signed-in user or a session", async () => {
		defaults.value = { logo: PNG };
		await expect(call({})).rejects.toMatchObject({ status: 401 });
	});

	it("is 404 when no logo is set", async () => {
		await expect(call({ sessionId: "s" })).rejects.toMatchObject({ status: 404 });
	});

	it("serves the image bytes, cacheable, with a locked-down content policy", async () => {
		defaults.value = { logo: PNG };
		const res = await call({ sessionId: "s" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("cache-control")).toContain("max-age");
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(new Uint8Array(await res.arrayBuffer())[1]).toBe(0x50); // "P" of PNG
	});

	it("answers 304 to a matching ETag", async () => {
		defaults.value = { logo: PNG };
		const first = await call({ sessionId: "s" });
		const etag = first.headers.get("etag") ?? "";
		const again = await call({ sessionId: "s" }, { "if-none-match": etag });
		expect(again.status).toBe(304);
	});
});
