import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { deleteConversationDeliverables } from "$lib/server/execution/deliverables";

/**
 * The snapshot end to end against a real store: the page is read once when the tool answers, kept in the
 * conversation's file store, and a reload serves it again **without the connector being reachable**
 * (nothing here reads a resource the second time), and without showing up as one of the user's files.
 */

const fake = vi.hoisted(() => ({
	read: vi.fn(),
	toolMeta: vi.fn(),
	allowed: vi.fn(async () => true),
}));

vi.mock("../tools", () => ({ getToolUiMeta: fake.toolMeta }));
vi.mock("./resource", async () => {
	class McpAppError extends Error {
		constructor(
			readonly code: string,
			message: string
		) {
			super(message);
		}
	}
	return { McpAppError, readUiResource: fake.read };
});
vi.mock("../appsPolicy", () => ({ appsAllowedFor: fake.allowed }));
vi.mock("$lib/server/auth", () => ({ authCondition: () => ({}) }));

const { appSnapshotFor } = await import("./snapshot");
const route = await import("../../../../routes/conversation/[id]/mcp-app/[sha256]/+server");

beforeAll(async () => {
	await ready;
});

let created: ObjectId[] = [];
afterEach(async () => {
	await deleteConversationDeliverables(created);
	created = [];
});

const HTML = "<!doctype html><html><body><p>interactive</p></body></html>";

describe("a page after a reload", () => {
	it("renders from the stored copy, with the connector unreachable", async () => {
		const conversationId = new ObjectId();
		created.push(conversationId);
		await collections.conversations.insertOne({
			_id: conversationId,
			userId: new ObjectId(),
			sessionId: "s",
			createdAt: new Date(),
			updatedAt: new Date(),
			messages: [],
		} as never);
		try {
			fake.toolMeta.mockResolvedValue({ listed: true, ui: { resourceUri: "ui://m/v" } });
			fake.read.mockResolvedValue({
				uri: "ui://m/v",
				html: HTML,
				bytes: HTML.length,
				csp: {},
				dropped: [],
			});
			const server = { key: "connector:1", name: "Maps", url: "https://maps.example/mcp" };

			const snapshot = await appSnapshotFor({ server, tool: "show", conversationId });
			expect(snapshot?.sha256).toMatch(/^[0-9a-f]{64}$/);

			// The reload: the connector is gone. Only the route is asked.
			fake.read.mockReset();
			fake.read.mockRejectedValue(new Error("connector unreachable"));
			const res = (await route.GET({
				params: { id: conversationId.toHexString(), sha256: snapshot?.sha256 ?? "" },
				locals: { user: { _id: new ObjectId() }, sessionId: "s" },
			} as never)) as Response;

			expect(res.status).toBe(200);
			expect(await res.text()).toBe(HTML);
			expect(fake.read).not.toHaveBeenCalled();

			// And it is the card's, not the user's: the file list leaves it out.
			const listed = await collections.codeExecutionOutputs
				.find({ conversationId, tool: { $ne: "mcp_app" } })
				.toArray();
			expect(listed).toHaveLength(0);
			expect(await collections.codeExecutionOutputs.countDocuments({ conversationId })).toBe(1);

			// The same page again (a second call of the tool, the connector back) is stored once.
			fake.read.mockResolvedValue({
				uri: "ui://m/v",
				html: HTML,
				bytes: HTML.length,
				csp: {},
				dropped: [],
			});
			const again = await appSnapshotFor({ server, tool: "show", conversationId });
			expect(again?.sha256).toBe(snapshot?.sha256);
			expect(await collections.codeExecutionOutputs.countDocuments({ conversationId })).toBe(1);
		} finally {
			await collections.conversations.deleteOne({ _id: conversationId });
		}
	});
});
