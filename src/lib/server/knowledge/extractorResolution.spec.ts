import { describe, expect, it } from "vitest";
import { resolveExtractor } from "./extractorResolution";

const LOCAL = { id: "markitdown", local: true };
const UPSTREAM = { id: "mistral-ocr-4.1", local: false };

describe("resolveExtractor", () => {
	it("env-fixed wins over everything, including a stored choice", () => {
		const answer = resolveExtractor({
			envModel: "env-reader",
			storedModel: "screen-reader",
			candidates: [LOCAL, UPSTREAM],
		});
		expect(answer).toEqual({ model: "env-reader", source: "env" });
	});

	it("stored choice wins with no env value", () => {
		const answer = resolveExtractor({
			envModel: null,
			storedModel: "screen-reader",
			candidates: [LOCAL, UPSTREAM],
		});
		expect(answer).toEqual({ model: "screen-reader", source: "stored" });
	});

	it("local extractor pre-selected with nothing chosen", () => {
		const answer = resolveExtractor({
			envModel: null,
			storedModel: null,
			candidates: [UPSTREAM, LOCAL],
		});
		expect(answer).toEqual({ model: "markitdown", source: "local-default" });
	});

	it("first available with no local extractor and nothing chosen", () => {
		const answer = resolveExtractor({
			envModel: null,
			storedModel: null,
			candidates: [UPSTREAM],
		});
		expect(answer).toEqual({ model: "mistral-ocr-4.1", source: "first-available" });
	});

	it("none when nothing is chosen and the catalogue is empty", () => {
		const answer = resolveExtractor({ envModel: null, storedModel: null, candidates: [] });
		expect(answer).toEqual({ model: null, source: "none" });
	});
});
