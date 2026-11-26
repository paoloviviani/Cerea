import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const fake = vi.hoisted(() => ({
	toolMeta: vi.fn(),
	read: vi.fn(),
	store: vi.fn(),
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
vi.mock("$lib/server/execution/deliverables", () => ({
	storeDeliverable: fake.store,
	MCP_APP_FILE_TOOL: "mcp_app",
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { appSnapshotFor, MCP_APP_FILE_TOOL } = await import("./snapshot");
const { McpAppError } = await import("./resource");

const conversationId = new ObjectId();
const server = { key: "connector:1", name: "Maps", url: "https://maps.example/mcp" };
const input = { server, tool: "show_map", conversationId, userId: new ObjectId(), messageId: "m1" };

beforeEach(() => {
	fake.toolMeta.mockReset();
	fake.read.mockReset();
	fake.store.mockReset();
	fake.toolMeta.mockResolvedValue({ listed: true, ui: { resourceUri: "ui://maps/view" } });
	fake.read.mockResolvedValue({
		uri: "ui://maps/view",
		html: "<p>map</p>",
		bytes: 10,
		csp: { connectDomains: ["https://api.example.com"] },
		dropped: [],
		prefersBorder: true,
	});
	fake.store.mockResolvedValue({
		ok: true,
		ref: { name: "mcp-app-x.html", size: 10, sha256: "f".repeat(64) },
	});
});

describe("the snapshot of a tool's page", () => {
	it("reads the page with the connector's credential and keeps a reference, not the HTML", async () => {
		const snapshot = await appSnapshotFor(input);

		expect(fake.read).toHaveBeenCalledWith(server, "ui://maps/view", expect.anything());
		expect(snapshot).toEqual({
			connector: "connector:1",
			server: "Maps",
			tool: "show_map",
			uri: "ui://maps/view",
			sha256: "f".repeat(64),
			size: 10,
			csp: { connectDomains: ["https://api.example.com"] },
			prefersBorder: true,
		});
		expect(JSON.stringify(snapshot)).not.toContain("<p>");
	});

	it("stores the HTML in the conversation's file store, marked so file lists leave it out", async () => {
		await appSnapshotFor(input);

		expect(fake.store).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId,
				mime: "text/html",
				tool: MCP_APP_FILE_TOOL,
				messageId: "m1",
				appPage: { connector: "connector:1", uri: "ui://maps/view" },
				bytes: Buffer.from("<p>map</p>"),
			})
		);
	});

	it("is nothing for a tool with no page, and the page is never read", async () => {
		fake.toolMeta.mockResolvedValue({ listed: true, ui: undefined });

		expect(await appSnapshotFor(input)).toBeUndefined();
		expect(fake.read).not.toHaveBeenCalled();
	});

	it("is nothing when apps are not allowed for the connector (no render, nothing stored)", async () => {
		fake.read.mockRejectedValue(new McpAppError("not-allowed", "blocked"));

		expect(await appSnapshotFor(input)).toBeUndefined();
		expect(fake.store).not.toHaveBeenCalled();
	});

	it("never throws: a page that cannot be read leaves the text result standing", async () => {
		for (const failure of [
			new McpAppError("mime", "not an app"),
			new McpAppError("size", "too big"),
			new Error("socket hang up"),
		]) {
			fake.read.mockRejectedValue(failure);
			await expect(appSnapshotFor(input)).resolves.toBeUndefined();
		}
		fake.toolMeta.mockRejectedValue(new Error("listing failed"));
		await expect(appSnapshotFor(input)).resolves.toBeUndefined();
	});

	it("is nothing when the page could not be kept", async () => {
		fake.store.mockResolvedValue({ ok: false, status: 413, error: "full" });
		expect(await appSnapshotFor(input)).toBeUndefined();
	});

	it("is nothing without a connector key or a conversation", async () => {
		expect(
			await appSnapshotFor({ ...input, server: { name: "x", url: "https://x/mcp" } })
		).toBeUndefined();
		expect(await appSnapshotFor({ ...input, conversationId: undefined })).toBeUndefined();
	});
});
