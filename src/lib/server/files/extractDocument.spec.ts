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
	config: {
		CHAT_OCR_MODEL: undefined,
		CHAT_OCR_BASE_URL: undefined,
		CHAT_OCR_API_KEY: undefined,
		CHAT_PDF_IMAGE_PAGES: undefined,
	},
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
import {
	assertOcrConfigValid,
	documentMime,
	extractDocument,
	resolveExtractorModel,
} from "./extractDocument";

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

	it("reads a text-layer PDF with the local reader when the OCR model is rate-limited", async () => {
		readConfigMock.mockResolvedValue({ extractorModel: "mistral-ocr-4.1" });
		gatewayGetMock.mockResolvedValue({
			data: [
				{ id: "markitdown", kind: "ocr", local: true },
				{ id: "mistral-ocr-4.1", kind: "ocr" },
			],
		});
		const { GatewayCallFailed } = await import("$lib/server/gatewayServer");
		gatewayPostMock.mockImplementation(
			async (_token: string, _path: string, body: { model: string }) => {
				if (body.model === "mistral-ocr-4.1") throw new GatewayCallFailed(429, "rate limited");
				return OCR_OK;
			}
		);

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "menu.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: true, text: "page one text" });
	});

	it("keeps the OCR model's reason when the local reader finds no text either", async () => {
		readConfigMock.mockResolvedValue({ extractorModel: "mistral-ocr-4.1" });
		gatewayGetMock.mockResolvedValue({
			data: [
				{ id: "markitdown", kind: "ocr", local: true },
				{ id: "mistral-ocr-4.1", kind: "ocr" },
			],
		});
		const { GatewayCallFailed } = await import("$lib/server/gatewayServer");
		gatewayPostMock.mockImplementation(
			async (_token: string, _path: string, body: { model: string }) => {
				if (body.model === "mistral-ocr-4.1") throw new GatewayCallFailed(429, "rate limited");
				throw new GatewayCallFailed(422, "This document has no text layer.");
			}
		);

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "scan.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({
			ok: false,
			status: 429,
			reason: "The document reader mistral-ocr-4.1 is rate-limited by its provider.",
		});
	});

	it("names the OCR model that came back empty instead of asking for an OCR model", async () => {
		readConfigMock.mockResolvedValue({ extractorModel: "mistral-ocr-4.1" });
		gatewayGetMock.mockResolvedValue({
			data: [
				{ id: "markitdown", kind: "ocr", local: true },
				{ id: "mistral-ocr-4.1", kind: "ocr" },
			],
		});
		gatewayPostMock.mockResolvedValue({ pages: [{ index: 0, markdown: "" }] });

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "scan.pdf",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, status: 422 });
		expect(answer.ok ? "" : answer.reason).toContain(
			"The OCR model mistral-ocr-4.1 returned no text"
		);
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

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MODELS = {
	data: [
		{ id: "mistral-ocr-4.1", kind: "ocr" },
		{ id: "markitdown", kind: "ocr", local: true },
	],
};

describe("routing: which reader takes which format", () => {
	it("never sends a .docx to the OCR model — not the env one, not the screen's", async () => {
		setEnvModel("mistral-ocr-4.1");
		readConfigMock.mockResolvedValue({ extractorModel: "mistral-ocr-4.1" });
		gatewayGetMock.mockResolvedValue(MODELS);
		gatewayPostMock.mockResolvedValue(OCR_OK);

		const answer = await extractDocument({
			bytes: BYTES,
			mime: DOCX,
			filename: "m.docx",
			token: "t",
		});

		expect(answer.ok).toBe(true);
		expect(gatewayPostMock).toHaveBeenCalledTimes(1);
		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "markitdown" });
		expect(gatewayPostMock.mock.calls[0][2].document.document_url).toMatch(
			/^data:application\/vnd\.openxmlformats/
		);
	});

	it("sends every non-PDF Office format to the local reader", async () => {
		setEnvModel("mistral-ocr-4.1");
		gatewayGetMock.mockResolvedValue(MODELS);
		gatewayPostMock.mockResolvedValue(OCR_OK);
		for (const mime of [
			"application/msword",
			"application/vnd.ms-excel",
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			"application/vnd.oasis.opendocument.text",
			"application/epub+zip",
		]) {
			gatewayPostMock.mockClear();
			await extractDocument({ bytes: BYTES, mime, filename: "f", token: "t" });
			expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "markitdown" });
		}
	});

	it("still sends a PDF to the selected OCR model", async () => {
		setEnvModel("mistral-ocr-4.1");
		gatewayGetMock.mockResolvedValue(MODELS);
		gatewayPostMock.mockResolvedValue(OCR_OK);

		await extractDocument({ bytes: BYTES, mime: "application/pdf", filename: "a.pdf", token: "t" });

		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "mistral-ocr-4.1" });
	});

	it("with no local reader a .docx fails saying so, and nothing is sent to the OCR model", async () => {
		setEnvModel("mistral-ocr-4.1");
		gatewayGetMock.mockResolvedValue({ data: [{ id: "mistral-ocr-4.1", kind: "ocr" }] });

		const answer = await extractDocument({
			bytes: BYTES,
			mime: DOCX,
			filename: "m.docx",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, kind: "no-reader", status: 503 });
		expect(answer.ok ? "" : answer.reason).toContain("No reader for Word documents");
		expect(gatewayPostMock).not.toHaveBeenCalled();
	});

	it("an unreachable catalogue is the same clear failure, not a call to the OCR model", async () => {
		setEnvModel("mistral-ocr-4.1");
		gatewayGetMock.mockRejectedValue(new Error("connection refused"));

		const answer = await extractDocument({
			bytes: BYTES,
			mime: "application/vnd.ms-excel",
			filename: "f.xls",
			token: "t",
		});

		expect(answer).toMatchObject({ ok: false, kind: "no-reader" });
		expect(answer.ok ? "" : answer.reason).toContain("spreadsheets");
		expect(gatewayPostMock).not.toHaveBeenCalled();
	});
});

describe("the kind of every failure travels with its reason", () => {
	const GatewayCallFailed = async () =>
		(await import("$lib/server/gatewayServer")).GatewayCallFailed;

	async function pdf() {
		readConfigMock.mockResolvedValue({ extractorModel: "reader" });
		return extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "a.pdf",
			token: "t",
		});
	}

	it("a refusal from the reader carries its own words", async () => {
		const Failed = await GatewayCallFailed();
		gatewayPostMock.mockRejectedValue(
			new Failed(422, "this is a legacy .doc; antiword is missing")
		);
		expect(await pdf()).toMatchObject({
			ok: false,
			kind: "refused",
			reason: "this is a legacy .doc; antiword is missing",
		});
	});

	it("another 4xx is a refusal too, not 'could not be reached'", async () => {
		const Failed = await GatewayCallFailed();
		gatewayPostMock.mockRejectedValue(new Failed(415, "unsupported media type"));
		expect(await pdf()).toMatchObject({
			ok: false,
			kind: "refused",
			reason: "unsupported media type",
		});
	});

	it("a provider failure or a network error is unreachable", async () => {
		const Failed = await GatewayCallFailed();
		gatewayPostMock.mockRejectedValue(new Failed(503, "upstream"));
		expect(await pdf()).toMatchObject({ ok: false, kind: "unreachable" });
		gatewayPostMock.mockRejectedValue(new Error("ECONNRESET"));
		expect(await pdf()).toMatchObject({ ok: false, kind: "unreachable", status: 502 });
	});

	it("a PDF with no text is no-text; an Office file with none is empty, with no scan advice", async () => {
		gatewayPostMock.mockResolvedValue({ pages: [{ markdown: " " }] });
		expect(await pdf()).toMatchObject({ ok: false, kind: "no-text" });

		gatewayGetMock.mockResolvedValue(MODELS);
		const empty = await extractDocument({
			bytes: BYTES,
			mime: DOCX,
			filename: "m.docx",
			token: "t",
		});
		expect(empty).toMatchObject({ ok: false, kind: "empty" });
		expect(empty.ok ? "" : empty.reason).not.toMatch(/scan|OCR/);
	});

	it("no reader and no credential are their own kinds", async () => {
		expect(
			await extractDocument({
				bytes: BYTES,
				mime: "application/pdf",
				filename: "a.pdf",
				token: "t",
			})
		).toMatchObject({ kind: "no-reader" });
		expect(
			await extractDocument({
				bytes: BYTES,
				mime: "application/pdf",
				filename: "a.pdf",
				token: undefined,
			})
		).toMatchObject({ kind: "no-credential" });
	});
});

describe("documentMime: a container whose name says Office is a candidate", () => {
	it("maps a compound file by its extension to the binary generation", () => {
		expect(documentMime("application/x-cfb", "menu.doc.docx")).toBe("application/msword");
		expect(documentMime("application/x-cfb", "Old.DOC")).toBe("application/msword");
		expect(documentMime("application/x-cfb", "t.xlsx")).toBe("application/vnd.ms-excel");
		expect(documentMime("application/x-cfb", "t.ppt")).toBe("application/vnd.ms-powerpoint");
	});

	it("leaves a compound file with another name alone", () => {
		expect(documentMime("application/x-cfb", "setup.msi")).toBe("application/x-cfb");
	});

	it("takes a plain zip named for an Office format, and nothing else zip-shaped", () => {
		expect(documentMime("application/zip", "m.docx")).toBe(DOCX);
		expect(documentMime("application/zip", "backup.zip")).toBe("application/zip");
	});

	it("keeps an already-known type", () => {
		expect(documentMime("application/pdf", "weird.docx")).toBe("application/pdf");
		expect(documentMime(DOCX, "m.docx")).toBe(DOCX);
	});
});

describe("a PDF's scanned pages as page images", () => {
	const JPEG = Buffer.from("fake-jpeg-bytes").toString("base64");
	const img = (page: number, mime = "image/jpeg") => ({ page, mime, data: JPEG });
	// A four-page PDF: text, scan, text, scan.
	const mixed = (extra: Record<string, unknown> = {}) => ({
		pages: [
			{ index: 0, markdown: "Page one has plenty of real text on it." },
			{ index: 1, markdown: "" },
			{ index: 2, markdown: "Page three also has plenty of real text." },
			{ index: 3, markdown: "" },
		],
		usage_info: { pages_processed: 4 },
		page_images: [img(4), img(2)],
		page_count: 4,
		truncated: false,
		...extra,
	});
	const ask = (pageImages: boolean | undefined = true) =>
		extractDocument({
			bytes: BYTES,
			mime: "application/pdf",
			filename: "scan.pdf",
			token: "t",
			pageImages,
		});
	const setLimit = (value: string | undefined) =>
		((config as unknown as { CHAT_PDF_IMAGE_PAGES?: string }).CHAT_PDF_IMAGE_PAGES = value);

	beforeEach(() => {
		setLimit(undefined);
		gatewayGetMock.mockResolvedValue(MODELS);
	});

	it("asks the local reader for pages whatever model the caller has, and puts text and scans back in page order", async () => {
		gatewayPostMock.mockResolvedValue(mixed());

		const answer = await ask();

		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({
			model: "markitdown",
			page_images: { max_pages: 20, long_side: 1280 },
		});
		expect(answer.ok).toBe(true);
		if (!answer.ok) return;
		expect(answer.text).toBe(
			[
				"Page one has plenty of real text on it.",
				"[[cerea:scan-page:2]]",
				"Page three also has plenty of real text.",
				"[[cerea:scan-page:4]]",
			].join("\n\n")
		);
		expect(answer.scan?.images.map((image) => image.page)).toEqual([2, 4]);
		expect(answer.scan).toMatchObject({ pageCount: 4, scannedTotal: 2, truncated: false });
		expect(answer.scan?.images[0].bytes.toString()).toBe("fake-jpeg-bytes");
	});

	it("a fully scanned PDF is text-less but still a success, with every page an image", async () => {
		gatewayPostMock.mockResolvedValue({
			pages: [
				{ index: 0, markdown: "" },
				{ index: 1, markdown: "" },
			],
			page_images: [img(1), img(2)],
			page_count: 2,
			truncated: false,
		});

		const answer = await ask();

		expect(answer).toMatchObject({
			ok: true,
			text: "[[cerea:scan-page:1]]\n\n[[cerea:scan-page:2]]",
			scan: { scannedTotal: 2 },
		});
	});

	it("says which scan pages were not read when the reader hit its limit", async () => {
		gatewayPostMock.mockResolvedValue({
			pages: [
				{ index: 0, markdown: "" },
				{ index: 1, markdown: "" },
				{ index: 2, markdown: "" },
			],
			page_images: [img(1), img(2)],
			page_count: 3,
			truncated: true,
		});

		const answer = await ask();

		if (!answer.ok) throw new Error("expected success");
		expect(answer.text).toContain("Page 3 is a scan that was not read");
		expect(answer.scan).toMatchObject({ pageCount: 3, scannedTotal: 3, truncated: true });
		expect(answer.scan?.images).toHaveLength(2);
	});

	it("keeps only well-formed images, each page once, at most the limit", async () => {
		setLimit("3");
		gatewayPostMock.mockResolvedValue({
			pages: [],
			page_images: [
				img(1, "image/gif"),
				{ page: 2, mime: "image/jpeg" },
				{ page: 3, mime: "image/jpeg", data: "" },
				{ page: 0, mime: "image/jpeg", data: JPEG },
				img(4),
				img(4),
				img(5),
				img(6),
				img(7),
			],
			page_count: 7,
		});

		const answer = await ask();

		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ page_images: { max_pages: 3 } });
		if (!answer.ok) throw new Error("expected success");
		expect(answer.scan?.images.map((image) => image.page)).toEqual([4, 5, 6]);
	});

	it("CHAT_PDF_IMAGE_PAGES=0 turns it off: no request for pages, the old no-text answer", async () => {
		setLimit("0");
		gatewayPostMock.mockResolvedValue({ pages: [{ markdown: "" }] });

		const answer = await ask();

		expect(gatewayPostMock.mock.calls[0][2]).not.toHaveProperty("page_images");
		expect(answer).toMatchObject({ ok: false, kind: "no-text" });
	});

	it("an unreadable setting falls back to 20, and a huge one is clamped", async () => {
		gatewayPostMock.mockResolvedValue({ pages: [{ markdown: "" }] });
		setLimit("lots");
		await ask();
		setLimit("500");
		await ask();
		expect(gatewayPostMock.mock.calls[0][2].page_images.max_pages).toBe(20);
		expect(gatewayPostMock.mock.calls[1][2].page_images.max_pages).toBe(50);
	});

	it("never asks a remote OCR model for pages", async () => {
		setEnvModel("mistral-ocr-4.1");
		gatewayPostMock.mockResolvedValue({ pages: [{ markdown: "" }] });

		const answer = await ask();

		// The remote model itself is never asked for pages (its empty answer then
		// sends the PDF to the local reader, which is: see the fallback test below).
		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "mistral-ocr-4.1" });
		expect(gatewayPostMock.mock.calls[0][2]).not.toHaveProperty("page_images");
		expect(answer).toMatchObject({ ok: false, kind: "empty" });
	});

	it("asks only when the caller can use the pages: not for a knowledge base's text", async () => {
		gatewayPostMock.mockResolvedValue(OCR_OK);
		await ask(false);
		await ask(undefined as never);
		// `undefined` defaults to false in the options object, `ask` above defaults to true.
		await extractDocument({ bytes: BYTES, mime: "application/pdf", filename: "a.pdf", token: "t" });
		expect(gatewayPostMock.mock.calls[0][2]).not.toHaveProperty("page_images");
		expect(gatewayPostMock.mock.calls[2][2]).not.toHaveProperty("page_images");
	});

	it("a PDF whose pages all have text is the ordinary answer, whatever was asked", async () => {
		gatewayPostMock.mockResolvedValue({ ...OCR_OK, page_images: [] });

		const answer = await ask();

		expect(answer).toMatchObject({ ok: true, text: "page one text" });
		expect(answer.ok && answer.scan).toBeFalsy();
	});

	it("the local reader reached as a fallback is asked for pages too, under the same rules", async () => {
		readConfigMock.mockResolvedValue({ extractorModel: "mistral-ocr-4.1" });
		const { GatewayCallFailed } = await import("$lib/server/gatewayServer");
		gatewayPostMock.mockImplementation(
			async (_token: string, _path: string, body: { model: string }) => {
				if (body.model === "mistral-ocr-4.1") throw new GatewayCallFailed(429, "rate limited");
				return mixed();
			}
		);

		const answer = await ask();

		const calls = gatewayPostMock.mock.calls.map((call) => call[2]);
		// The remote model is never asked for pages; the local one is.
		expect(calls[0]).toMatchObject({ model: "mistral-ocr-4.1" });
		expect(calls[0]).not.toHaveProperty("page_images");
		expect(calls[1]).toMatchObject({ model: "markitdown", page_images: { max_pages: 20 } });
		expect(answer.ok && answer.scan?.images.map((image) => image.page)).toEqual([2, 4]);

		// And not when the caller cannot use pages, or the setting is 0.
		gatewayPostMock.mockClear();
		await ask(false);
		expect(gatewayPostMock.mock.calls[1][2]).not.toHaveProperty("page_images");
		gatewayPostMock.mockClear();
		setLimit("0");
		await ask();
		expect(gatewayPostMock.mock.calls[1][2]).not.toHaveProperty("page_images");
	});
});
