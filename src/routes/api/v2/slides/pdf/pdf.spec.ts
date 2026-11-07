import { describe, it, expect, vi, beforeEach } from "vitest";

const renderer = vi.hoisted(() => ({
	available: true,
	render: vi.fn(),
}));

vi.mock("$lib/server/slides/renderPdf", () => {
	class PdfUnavailableError extends Error {}
	class PdfBusyError extends Error {}
	class PdfTooLargeError extends Error {}
	class PdfTimeoutError extends Error {}
	return {
		PdfUnavailableError,
		PdfBusyError,
		PdfTooLargeError,
		PdfTimeoutError,
		serverPdfAvailable: async () => renderer.available,
		renderDeckPdf: renderer.render,
	};
});

import { GET, POST } from "./+server";
import {
	PdfBusyError,
	PdfTimeoutError,
	PdfTooLargeError,
	PdfUnavailableError,
} from "$lib/server/slides/renderPdf";

const post = (body: unknown, locals: object = { sessionId: "s" }) =>
	POST({
		locals,
		request: new Request("http://app/api/v2/slides/pdf", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	} as never);

beforeEach(() => {
	renderer.available = true;
	renderer.render.mockReset();
	renderer.render.mockResolvedValue(Buffer.from("%PDF-1.7 fake"));
});

describe("GET /api/v2/slides/pdf", () => {
	it("says whether the renderer is there, to signed-in users only", async () => {
		await expect(GET({ locals: {} } as never)).rejects.toMatchObject({ status: 401 });
		expect(await (await GET({ locals: { sessionId: "s" } } as never)).json()).toEqual({
			available: true,
		});
		renderer.available = false;
		expect(await (await GET({ locals: { user: { _id: "u" } } } as never)).json()).toEqual({
			available: false,
		});
	});
});

describe("POST /api/v2/slides/pdf", () => {
	it("needs a user or session and a deck", async () => {
		await expect(post({ content: "<section>a</section>" }, {})).rejects.toMatchObject({
			status: 401,
		});
		await expect(post("not json")).rejects.toMatchObject({ status: 400 });
		await expect(post({ content: "" })).rejects.toMatchObject({ status: 400 });
		await expect(post({ content: "x".repeat(2_000_001) })).rejects.toMatchObject({ status: 413 });
	});

	it("answers 501 without a renderer, so the app falls back to printing", async () => {
		renderer.available = false;
		await expect(post({ content: "<section>a</section>" })).rejects.toMatchObject({ status: 501 });
		expect(renderer.render).not.toHaveBeenCalled();
	});

	it("renders the print document of the deck it was sent and returns the PDF", async () => {
		const res = await post({
			content: "<style></style><section><h1>Quarterly review</h1></section>",
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/pdf");
		expect(res.headers.get("content-disposition")).toContain("Quarterly-review.pdf");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("%PDF-1.7 fake");
		const html = renderer.render.mock.calls[0][0] as string;
		expect(html).toContain("Quarterly review");
		expect(html).toContain("data-print-ready");
		expect(html).toContain("default-src 'none'");
		// No print bar in the server's render: only the pages
		expect(html).not.toContain('id="cerea-print"');
	});

	it("passes the notes choice on", async () => {
		await post({ content: "<section>a</section>", notes: true });
		expect(renderer.render.mock.calls[0][0]).toContain('"notes":true');
	});

	it.each([
		[new PdfUnavailableError("x"), 501],
		[new PdfBusyError("x"), 429],
		[new PdfTooLargeError("x"), 413],
		[new PdfTimeoutError("x"), 504],
		[new Error("boom"), 500],
	])("maps %s to %i", async (err, status) => {
		renderer.render.mockRejectedValue(err);
		await expect(post({ content: "<section>a</section>" })).rejects.toMatchObject({ status });
	});
});
