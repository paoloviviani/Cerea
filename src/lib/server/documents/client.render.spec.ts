import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const config: Record<string, string> = {};
vi.mock("$lib/server/config", () => ({ config }));

const { renderPdf, DocumentsError, getCapabilities, resetCapabilitiesCache } =
	await import("./client");
import fixture from "./capabilities.fixture.json";

const SECRET = "s3cret";
let server: http.Server;
let seen: Array<{ path: string; body: string; secret: unknown }> = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			seen.push({
				path: req.url ?? "",
				body: Buffer.concat(chunks).toString("latin1"),
				secret: req.headers["x-cerea-documents-secret"],
			});
			res.writeHead(answer.status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(answer.body));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	config.CHAT_DOCUMENTS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	config.CHAT_DOCUMENTS_SECRET = SECRET;
});
afterAll(() => server.close());
beforeEach(() => {
	seen = [];
	resetCapabilitiesCache();
	answer = { status: 200, body: {} };
});

describe("renderPdf", () => {
	it("posts the PDF and the request, and reads the pages back", async () => {
		answer = {
			status: 200,
			body: {
				format: "pdf",
				page_count: 9,
				images: [
					{
						page: 2,
						width: 1200,
						height: 675,
						format: "png",
						content_type: "image/png",
						data_base64: "QUJD",
					},
				],
			},
		};
		const result = await renderPdf(Buffer.from("%PDF-1.7 x"), { pages: [2], max_side_px: 1200 });
		expect(seen[0].path).toBe("/v1/render");
		expect(seen[0].secret).toBe(SECRET);
		expect(seen[0].body).toContain('{"pages":[2],"max_side_px":1200}');
		expect(seen[0].body).toContain("%PDF-1.7 x");
		expect(result).toEqual({
			page_count: 9,
			pages: [
				{
					page: 2,
					width: 1200,
					height: 675,
					format: "png",
					content_type: "image/png",
					base64: "QUJD",
				},
			],
		});
	});

	it("says what the service refused, without 'nothing was changed' (a render changes nothing)", async () => {
		answer = {
			status: 422,
			body: {
				error: {
					code: "invalid_document",
					message: "the PDF is encrypted (password-protected), which this tool cannot open",
					reason: "encrypted",
				},
			},
		};
		const error = await renderPdf(Buffer.from("%PDF-1.7"), { width_px: 1000 }).catch((e) => e);
		expect(error).toBeInstanceOf(DocumentsError);
		expect(error.message).toBe(
			"the PDF is encrypted (password-protected), which this tool cannot open"
		);
		expect(error.message).not.toMatch(/Nothing was changed/);
	});

	it("refuses an answer with no pages", async () => {
		answer = { status: 200, body: { nothing: true } };
		await expect(renderPdf(Buffer.from("%PDF-1.7"), { width_px: 1000 })).rejects.toThrow(
			/returned no pages/
		);
	});
});

describe("the capabilities carry the render contract", () => {
	it("reads render and the limits", async () => {
		answer = {
			status: 200,
			body: {
				...fixture,
				limits: { max_render_pages: 6, max_render_px: 2000, max_pdf_pages: 2000 },
			},
		};
		const caps = await getCapabilities();
		expect(caps?.render).toEqual({ formats: ["pdf"], image_types: ["png", "jpeg"] });
		expect(caps?.limits).toEqual({ max_render_pages: 6, max_render_px: 2000 });
	});

	it("is absent from a service that predates it", async () => {
		const older: Record<string, unknown> = { ...fixture };
		delete older.render;
		answer = { status: 200, body: older };
		expect((await getCapabilities())?.render).toBeUndefined();
	});
});
