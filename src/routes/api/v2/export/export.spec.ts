import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const state = vi.hoisted(() => ({ added: [] as Array<{ name: string; text: string }> }));

vi.mock("yazl", () => ({
	default: {
		ZipFile: class {
			outputStream = {};
			addBuffer(buf: Buffer, name: string) {
				state.added.push({ name, text: buf.toString() });
			}
			end() {}
		},
	},
}));

vi.mock("$lib/server/config", () => ({ config: { ENABLE_DATA_EXPORT: "true" } }));
vi.mock("$lib/server/auth", () => ({ authCondition: () => ({}) }));
vi.mock("$lib/server/files/downloadFile", () => ({ downloadFile: async () => null }));

const CONVERSATION = {
	_id: new ObjectId(),
	messages: [
		{
			id: "m1",
			from: "assistant",
			content: "Hello Mario",
			updates: [{ type: "stream", token: "Hello" }],
			stats: {
				model: "Test",
				redaction: {
					applied: true,
					blocked: false,
					entities: [{ type: "PERSON", count: 1, sources: ["user"] }],
					values: [{ type: "PERSON", original: "Mario Rossi", placeholder: "<PERSON_1>" }],
				},
			},
		},
	],
};

vi.mock("$lib/server/database", () => ({
	collections: {
		messageEvents: { countDocuments: async () => 0, insertOne: async () => ({}) },
		conversations: { find: () => ({ toArray: async () => [CONVERSATION] }) },
	},
}));

describe("data export", () => {
	it("keeps the redaction summary but never the hidden values", async () => {
		const { GET } = await import("./+server");
		await GET({ locals: { user: { _id: new ObjectId() }, isAdmin: true } } as never);
		await vi.waitFor(() =>
			expect(state.added.some((f) => f.name === "conversations.json")).toBe(true)
		);
		const text = state.added.find((f) => f.name === "conversations.json")?.text ?? "";
		expect(text).toContain('"PERSON"');
		expect(text).toContain('"Test"');
		expect(text).not.toContain("Mario Rossi");
		expect(text).not.toContain("<PERSON_1>");
		expect(text).not.toContain('"values"');
	});
});
