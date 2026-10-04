import { describe, expect, it } from "vitest";
import { modelReadsImages } from "./modelReadsImages";

describe("modelReadsImages", () => {
	it("follows what the model advertises when the person has not said", () => {
		expect(modelReadsImages({ multimodal: true })).toBe(true);
		expect(modelReadsImages({ multimodal: false })).toBe(false);
		expect(modelReadsImages({})).toBe(false);
	});

	it("lets the person's override win in both directions", () => {
		expect(modelReadsImages({ multimodal: false }, true)).toBe(true);
		expect(modelReadsImages({ multimodal: true }, false)).toBe(false);
	});
});
