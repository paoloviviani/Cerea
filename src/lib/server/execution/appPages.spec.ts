import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	MAX_APP_PAGES_PER_CONVERSATION,
	MAX_APP_PAGE_VERSIONS,
	MAX_DELIVERABLES_PER_CONVERSATION,
	MCP_APP_FILE_TOOL,
	deleteConversationDeliverables,
	downloadDeliverable,
	openAppPage,
	openDeliverable,
	storeDeliverable,
} from "./deliverables";
import { createHash } from "node:crypto";

/**
 * The stored page of an MCP App is the card's, not the user's (docs/dev/adr-mcp-apps.md): it has its own
 * caps, is pruned by connector and address, and no file route serves it.
 */

beforeAll(async () => {
	await ready;
});

let created: ObjectId[] = [];
afterEach(async () => {
	await deleteConversationDeliverables(created);
	created = [];
});
const conv = () => {
	const id = new ObjectId();
	created.push(id);
	return id;
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const storePage = (
	conversationId: ObjectId,
	html: string,
	connector = "connector:1",
	uri = "ui://a/b"
) =>
	storeDeliverable({
		conversationId,
		name: `mcp-app-${sha(html).slice(0, 12)}.html`,
		mime: "text/html",
		bytes: Buffer.from(html),
		tool: MCP_APP_FILE_TOOL,
		appPage: { connector, uri },
	});

describe("a stored MCP App page", () => {
	it("is read back with the connector it was recorded for", async () => {
		const id = conv();
		const stored = await storePage(id, "<p>one</p>", "connector:7");
		if (!stored.ok) throw new Error("not stored");

		const page = await openAppPage(id, stored.ref.sha256);
		expect(page?.connector).toBe("connector:7");
	});

	it("is never served by the deliverable download routes or read as a file", async () => {
		const id = conv();
		const stored = await storePage(id, "<p>secret page</p>");
		if (!stored.ok) throw new Error("not stored");

		expect(await openDeliverable(id, stored.ref.sha256)).toBeUndefined();
		expect(await downloadDeliverable(id, stored.ref.sha256)).toBeUndefined();
	});

	it("does not count toward the conversation's deliverable caps", async () => {
		const id = conv();
		for (let i = 0; i < 5; i += 1) await storePage(id, `<p>${i}</p>`, `connector:${i}`);
		// The deliverable count is unaffected: a file is still accepted at the cap's edge.
		const rows = await collections.codeExecutionOutputs.countDocuments({
			conversationId: id,
			tool: { $ne: MCP_APP_FILE_TOOL },
		});
		expect(rows).toBe(0);
		const file = await storeDeliverable({
			conversationId: id,
			name: "report.txt",
			mime: "text/plain",
			bytes: Buffer.from("x"),
		});
		expect(file.ok).toBe(true);
		expect(MAX_DELIVERABLES_PER_CONVERSATION).toBeGreaterThan(5);
	});

	it("keeps the newest versions of one connector's page, and drops the older", async () => {
		const id = conv();
		for (let i = 0; i < MAX_APP_PAGE_VERSIONS + 2; i += 1) {
			await storePage(id, `<p>v${i}</p>`);
			await new Promise((r) => setTimeout(r, 5));
		}

		const left = await collections.codeExecutionOutputs
			.find({ conversationId: id, tool: MCP_APP_FILE_TOOL })
			.toArray();
		expect(left).toHaveLength(MAX_APP_PAGE_VERSIONS);
		const shas = left.map((r) => r.sha256);
		expect(shas).toContain(sha(`<p>v${MAX_APP_PAGE_VERSIONS + 1}</p>`));
		expect(shas).not.toContain(sha("<p>v0</p>"));
	});

	it("is capped overall, oldest first", async () => {
		const id = conv();
		for (let i = 0; i < MAX_APP_PAGES_PER_CONVERSATION + 3; i += 1) {
			await storePage(id, `<p>${i}</p>`, `connector:${i}`);
		}
		const count = await collections.codeExecutionOutputs.countDocuments({
			conversationId: id,
			tool: MCP_APP_FILE_TOOL,
		});
		expect(count).toBe(MAX_APP_PAGES_PER_CONVERSATION);
	});

	it("is the newest again when used again", async () => {
		const id = conv();
		for (let i = 0; i < MAX_APP_PAGE_VERSIONS; i += 1) {
			await storePage(id, `<p>v${i}</p>`);
			await new Promise((r) => setTimeout(r, 5));
		}
		await storePage(id, "<p>v0</p>");
		await new Promise((r) => setTimeout(r, 5));
		await storePage(id, "<p>new</p>");

		const shas = (
			await collections.codeExecutionOutputs
				.find({ conversationId: id, tool: MCP_APP_FILE_TOOL })
				.toArray()
		).map((r) => r.sha256);
		expect(shas).toContain(sha("<p>v0</p>"));
		expect(shas).not.toContain(sha("<p>v1</p>"));
	});
});
