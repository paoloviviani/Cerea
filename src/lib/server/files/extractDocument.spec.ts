import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What this module must get right is the *choice* and the *honesty*.
 *
 * The choice: which model reads a document — the Knowledge screen's when it
 * has named one, else the environment, else the catalogue. "Automatic" is the
 * absence of a choice, whatever it is stored as; there is no value that means
 * "read nothing", because there was one, and a deployment that held it
 * extracted no documents while the screen said it would.
 *
 * The honesty: every failure comes back with a reason a person can act on,
 * because the same answer lands on a knowledge base's failed document row,
 * where "failed" without a why sends somebody looking.
 */

const { readConfigMock, gatewayGetMock, gatewayPostMock } = vi.hoisted(() => ({
	readConfigMock: vi.fn(),
	gatewayGetMock: vi.fn(),
	gatewayPostMock: vi.fn(),
}));

vi.mock("$lib/server/config", () => ({ config: { CHAT_OCR_MODEL: undefined } }));

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
import { extractDocument, resolveExtractorModel } from "./extractDocument";

const OCR_OK = {
	pages: [{ index: 0, markdown: "page one text" }],
	usage_info: { pages_processed: 1 },
};

const BYTES = new TextEncoder().encode("%PDF-1.4 not really").buffer as ArrayBuffer;

function setEnvModel(value: string | undefined) {
	(config as unknown as { CHAT_OCR_MODEL: string | undefined }).CHAT_OCR_MODEL = value;
}

beforeEach(() => {
	readConfigMock.mockResolvedValue({ extractorModel: undefined });
	gatewayGetMock.mockResolvedValue({ data: [] });
	setEnvModel(undefined);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("which model reads", () => {
	it("uses the Knowledge screen's choice when it names one", async () => {
		readConfigMock.mockResolvedValue({ extractorModel: "screen-reader" });
		gatewayPostMock.mockResolvedValue(OCR_OK);

		await extractDocument({ bytes: BYTES, mime: "application/pdf", filename: "a.pdf", token: "t" });

		expect(gatewayPostMock.mock.calls[0][1]).toBe("ocr");
		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "screen-reader" });
	});

	it("treats a stored null as Automatic: the environment model next", async () => {
		// A row written by the screen's old "built-in" option. It used to mean
		// "extract nothing"; it means the deployment default now.
		readConfigMock.mockResolvedValue({ extractorModel: null });
		setEnvModel("env-reader");
		gatewayPostMock.mockResolvedValue(OCR_OK);

		await extractDocument({ bytes: BYTES, mime: "application/pdf", filename: "a.pdf", token: "t" });

		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "env-reader" });
	});

	it("with no screen choice and no environment model, the first reader the caller may use", async () => {
		gatewayGetMock.mockResolvedValue({
			data: [
				{ id: "chat-model", kind: "chat" },
				{ id: "markitdown", kind: "ocr" },
			],
		});
		gatewayPostMock.mockResolvedValue(OCR_OK);

		await extractDocument({ bytes: BYTES, mime: "application/pdf", filename: "a.pdf", token: "t" });

		expect(gatewayGetMock).toHaveBeenCalledWith("t", "models");
		expect(gatewayPostMock.mock.calls[0][2]).toMatchObject({ model: "markitdown" });
	});

	it("resolveExtractorModel answers the same question without reading anything", async () => {
		readConfigMock.mockResolvedValue({ extractorModel: "screen-reader" });
		await expect(resolveExtractorModel("t")).resolves.toBe("screen-reader");

		readConfigMock.mockResolvedValue({ extractorModel: null });
		gatewayGetMock.mockResolvedValue({ data: [{ id: "markitdown", kind: "ocr" }] });
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
