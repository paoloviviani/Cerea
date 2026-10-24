import { describe, it, expect, vi } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("$lib/server/database", () => ({
	collections: { mcpConnectors: { find: () => ({ toArray: async () => [] }) } },
}));
vi.mock("./oauth", () => ({ bearerFor: async () => undefined }));
vi.mock("./local", () => ({
	resolveLocalSelection: async () => ({
		servers: [{ name: "calendar · on laptop", url: "machine://x" }],
		unavailable: [],
	}),
}));

const { mcpLocalsFor } = await import("./selection");

describe("the names a turn is narrowed by", () => {
	it("lists a local connector once when the browser sent it by name and by id", async () => {
		const locals = await mcpLocalsFor(
			{
				customServers: [],
				connectorIds: [new ObjectId().toString()],
				serverNames: ["calendar · on laptop", "Notion"],
			},
			new ObjectId()
		);
		expect(locals.selectedServerNames).toEqual(["calendar · on laptop", "Notion"]);
	});
});
