import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { MessageUpdateType, type MessageUpdate } from "$lib/types/MessageUpdate";
import { generate } from "./generate";

vi.mock("../abortedGenerations", () => ({
	AbortedGenerations: { getInstance: () => ({ getAbortTime: () => undefined }) },
}));

async function* fakeEndpoint() {
	yield { token: { id: 0, text: "Hi", logprob: 0, special: false }, generated_text: null };
	yield {
		token: { id: 1, text: "", logprob: 0, special: true },
		generated_text: "Hi",
	};
	yield {
		token: { id: 2, text: "", logprob: 0, special: true },
		generated_text: null,
		callReport: {
			inputTokens: 8,
			outputTokens: 2,
			redaction: {
				applied: true,
				blocked: false,
				entities: [{ type: "PERSON", count: 1, sources: [] }],
			},
		},
	};
}

describe("generate (a turn with no tools)", () => {
	it("ends with the turn's stats: model name, tokens and redaction", async () => {
		const updates: MessageUpdate[] = [];
		for await (const update of generate({
			model: { displayName: "Test model", parameters: {} },
			endpoint: async () => fakeEndpoint(),
			conv: { _id: new ObjectId() },
			messages: [{ from: "user", content: "hello" }],
			promptedAt: new Date(),
			locals: {},
			abortController: new AbortController(),
		} as unknown as Parameters<typeof generate>[0])) {
			updates.push(update);
		}
		const last = updates.at(-1);
		expect(last?.type).toBe(MessageUpdateType.TurnStats);
		if (last?.type !== MessageUpdateType.TurnStats) return;
		expect(last.stats.model).toBe("Test model");
		expect(last.stats.inputTokens).toBe(8);
		expect(last.stats.redaction?.entities[0].count).toBe(1);
		expect(updates.some((u) => u.type === MessageUpdateType.FinalAnswer)).toBe(true);
	});

	it("turns the turn blocked when the gateway refuses with a 403 body", async () => {
		const updates: MessageUpdate[] = [];
		const refusal = Object.assign(new Error("403"), {
			status: 403,
			error: { pystino_redaction: { applied: true, blocked: true, entities: [] } },
		});
		await expect(async () => {
			for await (const update of generate({
				model: { displayName: "Test model", parameters: {} },
				endpoint: async () => {
					throw refusal;
				},
				conv: { _id: new ObjectId() },
				messages: [{ from: "user", content: "hello" }],
				promptedAt: new Date(),
				locals: {},
				abortController: new AbortController(),
			} as unknown as Parameters<typeof generate>[0])) {
				updates.push(update);
			}
		}).rejects.toBe(refusal);
		const last = updates.at(-1);
		expect(last?.type === MessageUpdateType.TurnStats && last.stats.redaction?.blocked).toBe(true);
	});
});
