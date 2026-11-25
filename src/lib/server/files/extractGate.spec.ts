import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ available: vi.fn(), reader: vi.fn() }));
vi.mock("./extractDocument", () => ({ extractorAvailable: mocks.available }));
vi.mock("./userReader", () => ({ userDocumentReader: mocks.reader }));

const { docExtractGate, resetDocExtractGate, EXTRACT_GATE_TTL_MS } = await import("./extractGate");

beforeEach(() => {
	vi.useFakeTimers();
	resetDocExtractGate();
	mocks.available.mockReset().mockResolvedValue(true);
	mocks.reader.mockReset().mockResolvedValue({ model: "ocr-1", local: false });
});
afterEach(() => vi.useRealTimers());

describe("docExtractGate", () => {
	it("asks the gateway once a minute per credential, not on every turn", async () => {
		const locals = {} as App.Locals;
		expect(await docExtractGate(locals, "tok")).toEqual({
			token: "tok",
			readerModel: "ocr-1",
			readerLocal: false,
		});
		await docExtractGate(locals, "tok");
		expect(mocks.available).toHaveBeenCalledTimes(1);
		expect(mocks.reader).toHaveBeenCalledTimes(1);
		await docExtractGate(locals, "other");
		expect(mocks.available).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(EXTRACT_GATE_TTL_MS + 1);
		await docExtractGate(locals, "tok");
		expect(mocks.available).toHaveBeenCalledTimes(3);
	});

	it("answers nothing, and remembers it, when no extractor is available", async () => {
		mocks.available.mockResolvedValue(false);
		expect(await docExtractGate({} as App.Locals, "tok")).toBeUndefined();
		await docExtractGate({} as App.Locals, "tok");
		expect(mocks.available).toHaveBeenCalledTimes(1);
	});
});
