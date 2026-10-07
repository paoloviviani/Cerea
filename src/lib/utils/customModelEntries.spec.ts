import { describe, expect, it } from "vitest";
import type { GETModelsResponse } from "$lib/server/api/types";
import { customModelEntries, modelLabel, settingsModelId } from "./customModelEntries";
import { customModelId, customModelObjectId, isCustomModelId } from "./customModelId";

const entry = (over: Partial<GETModelsResponse[number]>): GETModelsResponse[number] => ({
	id: "org/base",
	name: "org/base",
	displayName: "GLM 5.3 Flash",
	description: "The base",
	logoUrl: "https://logo",
	multimodal: true,
	multimodalAcceptedMimetypes: ["image/png"],
	supportsTools: true,
	supportsReasoning: true,
	supportsArtifacts: true,
	unlisted: false,
	hasInferenceAPI: true,
	isRouter: false,
	preprompt: "deployment prompt",
	...over,
});

const id = customModelId("0123456789abcdef01234567");

describe("custom model ids", () => {
	it("are `custom:<objectId>`, and nothing else is one", () => {
		expect(id).toBe("custom:0123456789abcdef01234567");
		expect(isCustomModelId(id)).toBe(true);
		expect(customModelObjectId(id)).toBe("0123456789abcdef01234567");
		for (const other of [
			"org/base",
			"custom:short",
			"custom:0123456789abcdef0123456",
			"xcustom:0123456789abcdef01234567",
			"custom:0123456789abcdef01234567/x",
			"",
			undefined,
		]) {
			expect(isCustomModelId(other)).toBe(false);
			expect(customModelObjectId(other)).toBeUndefined();
		}
	});
});

describe("customModelEntries", () => {
	const view = { id, name: "Menu helper", baseModelId: "org/base" };

	it("inherits everything the base advertises, so gating carries over", () => {
		const [custom] = customModelEntries([view], [entry({ isRouter: true })]);
		expect(custom).toMatchObject({
			id,
			name: "Menu helper",
			displayName: "Menu helper",
			multimodal: true,
			multimodalAcceptedMimetypes: ["image/png"],
			supportsTools: true,
			supportsReasoning: true,
			supportsArtifacts: true,
			isRouter: true,
			logoUrl: "https://logo",
			unlisted: false,
			customBase: { id: "org/base", displayName: "GLM 5.3 Flash" },
		});
	});

	it("carries a text-only, no-reasoning base as exactly that", () => {
		const base = entry({
			multimodal: false,
			supportsTools: false,
			supportsReasoning: false,
			supportsArtifacts: false,
		});
		const [custom] = customModelEntries([view], [base]);
		expect(custom).toMatchObject({
			multimodal: false,
			supportsTools: false,
			supportsReasoning: false,
			supportsArtifacts: false,
		});
	});

	it("keeps the base's deployment preprompt (so the composer shows no system-prompt chip), and prefers its own description", () => {
		const [plain] = customModelEntries([view], [entry({})]);
		expect(plain.preprompt).toBe("deployment prompt");
		expect(plain.description).toBe("The base");
		const [described] = customModelEntries(
			[{ ...view, description: "Plans lunches" }],
			[entry({})]
		);
		expect(described.description).toBe("Plans lunches");
	});

	it("leaves out a model whose base is not in the catalogue", () => {
		expect(customModelEntries([view], [entry({ id: "other/model" })])).toEqual([]);
	});
});

describe("labels and settings keys", () => {
	it("names a custom model with its base, and keys its settings by the base", () => {
		const [custom] = customModelEntries(
			[{ id, name: "Menu helper", baseModelId: "org/base" }],
			[entry({})]
		);
		expect(modelLabel(custom)).toBe("Menu helper · GLM 5.3 Flash");
		expect(settingsModelId(custom)).toBe("org/base");
	});

	it("leaves a catalogue model as it is", () => {
		const base = entry({});
		expect(modelLabel(base)).toBe("GLM 5.3 Flash");
		expect(settingsModelId(base)).toBe("org/base");
	});
});
