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
	// Server-side memory state: frozen memory and a stored tail block, neither the user's data.
	memorySnapshot: { globalOn: true, global: [{ id: "g1", text: "Frozen fact." }], project: [] },
	messages: [
		{
			id: "m1",
			from: "assistant",
			content: "Hello Mario",
			memoryBlock: "[NOTES FOR THIS CHAT: Stored block text.]",
			updates: [{ type: "stream", token: "Hello" }],
			files: [
				{
					type: "hash",
					value: "abc",
					name: "secret.pdf",
					mime: "application/pdf",
					withheld: { rule: "no-health", pipeline: "strict" },
				},
			],
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
		// A withheld file is listed by name and reason, with no bytes in the zip.
		expect(text).toContain("secret.pdf");
		expect(text).toContain("withheld by privacy rule 'no-health' (pipeline 'strict')");
		expect(state.added.filter((f) => f.name.startsWith("file-"))).toHaveLength(0);
		// What the chat froze or replayed from memory is not part of the user's export.
		expect(text).not.toContain("memorySnapshot");
		expect(text).not.toContain("Frozen fact.");
		expect(text).not.toContain("Stored block text.");
	});
});
