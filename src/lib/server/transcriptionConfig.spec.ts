/** The admin's transcription choice, against the real database: stored, resolved first, and kept by the pipeline's own saves. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("$lib/server/gatewayServer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/gatewayServer")>();
	return { ...actual, gateway: { ...actual.gateway, get } };
});

import { collections, ready } from "$lib/server/database";
import { writeConfig } from "$lib/server/knowledge/service";
import {
	clearTranscriptionModelCache,
	resolveTranscriptionModel,
	writeTranscriptionModel,
} from "./transcription";

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	clearTranscriptionModelCache();
	await collections.knowledgeConfig.deleteMany({});
	await collections.voiceConfig.deleteMany({});
});

describe("the stored transcription model", () => {
	it("wins over the first available model, and clearing returns to it", async () => {
		get.mockResolvedValue({ data: [{ id: "first-one", kind: "transcription" }] });
		expect((await resolveTranscriptionModel("t")).model).toBe("first-one");

		await writeTranscriptionModel("voxtral-mini");
		expect(await resolveTranscriptionModel("t")).toEqual({
			model: "voxtral-mini",
			source: "stored",
		});

		await writeTranscriptionModel(null);
		expect((await resolveTranscriptionModel("t")).model).toBe("first-one");
	});

	it("reads the Knowledge screen's old field until a choice is saved here, and the new one wins", async () => {
		get.mockResolvedValue({ data: [{ id: "first-one", kind: "transcription" }] });
		await collections.knowledgeConfig.insertOne({
			transcriptionModel: "old-home",
			enabled: false,
			embeddingModel: null,
			chunkChars: 1200,
			chunkOverlap: 150,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		expect((await resolveTranscriptionModel("t")).model).toBe("old-home");

		await writeTranscriptionModel("new-home");
		expect((await resolveTranscriptionModel("t")).model).toBe("new-home");
		// The old field is gone, so clearing returns to the default rather than to it.
		expect((await collections.knowledgeConfig.findOne({}))?.transcriptionModel).toBeUndefined();
		await writeTranscriptionModel(null);
		expect((await resolveTranscriptionModel("t")).model).toBe("first-one");
	});

	it("survives a save of the knowledge pipeline's own settings", async () => {
		await writeTranscriptionModel("whisper-large-v3");
		await writeConfig({ chunkChars: 900 });
		clearTranscriptionModelCache();
		expect((await resolveTranscriptionModel("t")).model).toBe("whisper-large-v3");
	});
});
