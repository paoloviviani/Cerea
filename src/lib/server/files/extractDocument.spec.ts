import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What this module must get right is the *choice* and the *honesty*.
 *
 * The choice: which model reads a document — an env value first (the
 * operator who names one means it), then the Knowledge screen's stored
 * choice, then this deployment's own local extractor when the gateway flags
 * one `local: true`, then the first reader in the catalogue, then none.
 * "Automatic" is the absence of a choice, whatever it is stored as; there is
 * no value that means "read nothing", because there was one, and a
 * deployment that held it extracted no documents while the screen said it
 * would.
 *
 * The honesty: every failure comes back with a reason a person can act on —
 * a provider-side failure (429, 5xx) names the reader rather than reading as
 * "not available" — because the same answer lands on a knowledge base's
 * failed document row, where "failed" without a why sends somebody looking.
 */

const { readConfigMock, gatewayGetMock, gatewayPostMock } = vi.hoisted(() => ({
	readConfigMock: vi.fn(),
	gatewayGetMock: vi.fn(),
	gatewayPostMock: vi.fn(),
}));

vi.mock("$lib/server/config", () => ({
	config: { CHAT_OCR_MODEL: undefined, CHAT_OCR_BASE_URL: undefined, CHAT_OCR_API_KEY: undefined },
}));

vi.mock("$lib/server/knowledge/service", () => ({ readConfig: readConfigMock }));

vi.mock("$lib/server/gatewayServer", () => {
	class GatewayCallFailed extends Error {
		constructor(
			readonly status: number,
			message: string
		) {
			super(message);
			this.name = "GatewayCallFailed";
		}
	}
	return {
		GatewayCallFailed,
		gateway: { get: gatewayGetMock, post: gatewayPostMock, del: vi.fn() },
	};
});

import { config } from "$lib/server/config";
import { assertOcrConfigValid, extractDocument, resolveExtractorModel } from "./extractDocument";

const OCR_OK = {
	pages: [{ index: 0, markdown: "page one text" }],
	usage_info: { pages_processed: 1 },
};

const BYTES = new TextEncoder().encode("%PDF-1.4 not really").buffer as ArrayBuffer;

type MutableConfig = {
	CHAT_OCR_MODEL: string | undefined;
	CHAT_OCR_BASE_URL: string | undefined;
	CHAT_OCR_API_KEY: string | undefined;
};

function setEnvModel(value: string | undefined) {
	(config as unknown as MutableConfig).CHAT_OCR_MODEL = value;
}

function setEnvBaseUrl(value: string | undefined) {
	(config as unknown as MutableConfig).CHAT_OCR_BASE_URL = value;
}

function setEnvApiKey(value: string | undefined) {
	(config as unknown as MutableConfig).CHAT_OCR_API_KEY = value;
}

function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
	} as Response;
}

const realFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	readConfigMock.mockResolvedValue({ extractorModel: undefined });
	gatewayGetMock.mockResolvedValue({ data: [] });
	setEnvModel(undefined);
	setEnvBaseUrl(undefined);
	setEnvApiKey(undefined);
	fetchMock = vi.fn();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
	vi.clearAllMocks();
	globalThis.fetch = realFetch;
});

describe("which model reads", () => {
	it("env-fixed: CHAT_OCR_MODEL wins even over a stored screen choice", async () => {
		readConfigMock.mockResolvedValue({ extractorModel: "screen-reader" });
		setEnvModel("env-reader");
		gatewayPostMock.mockResolvedValue(OCR_OK);

		await extractDocument({ bytes: BYTES, mime: "application/pdf", filename: "a.pdf", token: "t" });

		expect(gatewayPostMock.mock.calls[0][1]).toBe("ocr");
		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "env-reader" });
		expect(gatewayGetMock).not.toHaveBeenCalled();
	});

	it("stored choice: the Knowledge screen's own selection, with no env value set", async () => {
		readConfigMock.mockResolvedValue({ extractorModel: "screen-reader" });
		gatewayPostMock.mockResolvedValue(OCR_OK);

		await extractDocument({ bytes: BYTES, mime: "application/pdf", filename: "a.pdf", token: "t" });

		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "screen-reader" });
	});

	it("local extractor pre-selected: nothing chosen, the gateway flags one local", async () => {
		// A row written by the screen's old "built-in" option. It used to mean
		// "extract nothing"; it means the deployment default now.
		readConfigMock.mockResolvedValue({ extractorModel: null });
		gatewayGetMock.mockResolvedValue({
			data: [
				{ id: "mistral-ocr-4.1", kind: "ocr" },
				{ id: "markitdown", kind: "ocr", local: true },
			],
		});
		gatewayPostMock.mockResolvedValue(OCR_OK);

		await extractDocument({ bytes: BYTES, mime: "application/pdf", filename: "a.pdf", token: "t" });

		expect(gatewayGetMock).toHaveBeenCalledWith("t", "models?include=ocr");
		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "markitdown" });
	});

	it("first available: no local extractor, no screen choice, no env model", async () => {
		gatewayGetMock.mockResolvedValue({
			data: [
				{ id: "chat-model", kind: "chat" },
				{ id: "mistral-ocr-4.1", kind: "ocr" },
			],
		});
		gatewayPostMock.mockResolvedValue(OCR_OK);

		await extractDocument({ bytes: BYTES, mime: "application/pdf", filename: "a.pdf", token: "t" });

		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "mistral-ocr-4.1" });
	});

	it("an old gateway with no `local` flag still resolves to the first reader", async () => {
		// `?include=ocr` against a gateway that predates the flag: a normal
		// catalogue answer, no `local` key on any card at all.
		gatewayGetMock.mockResolvedValue({ data: [{ id: "mistral-ocr-4.1", kind: "ocr" }] });
		gatewayPostMock.mockResolvedValue(OCR_OK);

		await extractDocument({ bytes: BYTES, mime: "application/pdf", filename: "a.pdf", token: "t" });

		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "mistral-ocr-4.1" });
	});

	it("none: nothing chosen and nothing in the catalogue either", async () => {
		gatewayGetMock.mockResolvedValue({ data: [{ id: "chat-model", kind: "chat" }] });

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, status: 503 });
		expect(gatewayPostMock).not.toHaveBeenCalled();
	});

	it("resolveExtractorModel answers the same question without reading anything", async () => {
		setEnvModel("env-reader");
		await expect(resolveExtractorModel("t")).resolves.toBe("env-reader");
		setEnvModel(undefined);

		readConfigMock.mockResolvedValue({ extractorModel: "screen-reader" });
		await expect(resolveExtractorModel("t")).resolves.toBe("screen-reader");

		readConfigMock.mockResolvedValue({ extractorModel: null });
		gatewayGetMock.mockResolvedValue({
			data: [{ id: "markitdown", kind: "ocr", local: true }],
		});
		await expect(resolveExtractorModel("t")).resolves.toBe("markitdown");

		gatewayGetMock.mockResolvedValue({ data: [{ id: "chat-model" }] });
		await expect(resolveExtractorModel("t")).resolves.toBeNull();
	});
});

describe("when there is no text", () => {
	it("names the deployment, not the document, when no reader is configured", async () => {
		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, status: 503 });
		expect(answer.ok ? "" : answer.reason).toContain("no document reader configured");
	});

	it("quotes the gateway's refusal for a document it cannot read", async () => {
		gatewayGetMock.mockResolvedValue({ data: [{ id: "markitdown", kind: "ocr" }] });
		const { GatewayCallFailed } = await import("$lib/server/gatewayServer");
		gatewayPostMock.mockRejectedValue(
			new GatewayCallFailed(
				422,
				"This document has no text layer — it is a scan or a set of images."
			)
		);

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "scan.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({
			ok: false,
			status: 422,
			reason: "This document has no text layer — it is a scan or a set of images.",
		});
	});

	it("names the reader and the rate limit, rather than a generic unavailable", async () => {
		gatewayGetMock.mockResolvedValue({ data: [{ id: "mistral-ocr-4.1", kind: "ocr" }] });
		const { GatewayCallFailed } = await import("$lib/server/gatewayServer");
		gatewayPostMock.mockRejectedValue(new GatewayCallFailed(429, "the provider answered 429"));

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({
			ok: false,
			status: 429,
			reason: "The document reader mistral-ocr-4.1 is rate-limited by its provider.",
		});
	});

	it("names the reader and the status on a provider-side 5xx", async () => {
		gatewayGetMock.mockResolvedValue({ data: [{ id: "mistral-ocr-4.1", kind: "ocr" }] });
		const { GatewayCallFailed } = await import("$lib/server/gatewayServer");
		gatewayPostMock.mockRejectedValue(new GatewayCallFailed(503, "the provider answered 503"));

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({
			ok: false,
			status: 503,
			reason:
				"The document reader mistral-ocr-4.1 is unavailable right now — its provider answered 503.",
		});
	});

	it("says a scan needs an OCR model when the reader returns no text", async () => {
		gatewayGetMock.mockResolvedValue({ data: [{ id: "markitdown", kind: "ocr" }] });
		gatewayPostMock.mockResolvedValue({ pages: [{ index: 0, markdown: "  " }] });

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "scan.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, status: 422 });
		expect(answer.ok ? "" : answer.reason).toContain("scan needs an OCR model");
	});

	it("keeps the gateway's status for anything else that goes wrong", async () => {
		gatewayGetMock.mockResolvedValue({ data: [{ id: "markitdown", kind: "ocr" }] });
		const { GatewayCallFailed } = await import("$lib/server/gatewayServer");
		gatewayPostMock.mockRejectedValue(new GatewayCallFailed(500, "The gateway answered 500."));

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, status: 500 });
		expect(answer.ok ? "" : answer.reason).not.toContain("no text layer");
	});

	it("refuses without a credential rather than pretending to have read", async () => {
		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: undefined,
		});

		expect(answer).toMatchObject({ ok: false, status: 401 });
		expect(gatewayPostMock).not.toHaveBeenCalled();
	});
});

describe("boot-time config validation", () => {
	it("throws when a base URL is set but no model is named", () => {
		setEnvBaseUrl("https://api.mistral.ai/v1");
		setEnvModel(undefined);

		expect(() => assertOcrConfigValid()).toThrow(/CHAT_OCR_MODEL/);
	});

	it("does not throw with neither set, or with both set", () => {
		expect(() => assertOcrConfigValid()).not.toThrow();

		setEnvBaseUrl("https://api.mistral.ai/v1");
		setEnvModel("mistral-ocr-latest");
		expect(() => assertOcrConfigValid()).not.toThrow();
	});
});

describe("direct mode: CHAT_OCR_BASE_URL set, no gateway", () => {
	beforeEach(() => {
		setEnvBaseUrl("https://api.mistral.ai/v1");
		setEnvModel("mistral-ocr-latest");
	});

	it("resolveExtractorModel answers CHAT_OCR_MODEL directly, overriding the Knowledge screen", async () => {
		readConfigMock.mockResolvedValue({ extractorModel: "screen-reader" });

		await expect(resolveExtractorModel("t")).resolves.toBe("mistral-ocr-latest");
		expect(readConfigMock).not.toHaveBeenCalled();
	});

	it("posts to {baseUrl}/ocr directly with a bearer key, never touching the gateway", async () => {
		setEnvApiKey("secret-key");
		fetchMock.mockResolvedValue(jsonResponse(200, OCR_OK));

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: true, text: "page one text", pages: 1 });
		expect(gatewayPostMock).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.mistral.ai/v1/ocr");
		expect(init.headers.Authorization).toBe("Bearer secret-key");
		const body = JSON.parse(init.body);
		expect(body.model).toBe("mistral-ocr-latest");
		expect(body.document.type).toBe("document_url");
	});

	it("rejects a non-PDF document with the spelled-out reason, never calling the endpoint", async () => {
		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			filename: "a.docx",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, status: 422 });
		expect(answer.ok ? "" : answer.reason).toContain("PDFs only");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects an oversized document before ever calling the endpoint", async () => {
		const big = new ArrayBuffer(11 * 1024 * 1024);

		const answer = await extractDocument({
			bytes: big,
			mime: "application/pdf",
			filename: "big.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, status: 413 });
		expect(answer.ok ? "" : answer.reason).toContain("too large");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("quotes the endpoint's error message when its envelope has one", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(400, { error: { message: "document_url must be a valid data URI" } })
		);

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({
			ok: false,
			status: 400,
			reason: "document_url must be a valid data URI",
		});
	});

	it("names the reader and the status for a 5xx with no parseable error body", async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 500,
			json: () => Promise.reject(new Error("not json")),
		});

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({
			ok: false,
			status: 500,
			reason:
				"The document reader mistral-ocr-latest is unavailable right now — its provider answered 500.",
		});
	});

	it("degrades the same way when the network call itself throws", async () => {
		fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, status: 502 });
	});

	it("degrades when a 200 response body cannot be parsed as JSON", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.reject(new Error("not json")),
		});

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, status: 502 });
	});

	it("says the endpoint returned no text when pages carry none", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { pages: [{ index: 0, markdown: "  " }] }));

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "scan.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, status: 422 });
		expect(answer.ok ? "" : answer.reason).toContain("returned no text");
	});
});
